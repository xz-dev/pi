//! The single writer of stdout. Control frames (results, errors, pings, watch events) always go before bulk command
//! output, so a slow link delays output but never a cancel's result or a ping. Bulk output is bounded: readers of
//! commands without an output window wait while too much of it is unsent, which slows the command down like a full
//! pipe would.

use crate::frame::{self, Frame};
use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Unsent bulk bytes above which unwindowed command output waits.
const BULK_LIMIT: usize = 4 * 1024 * 1024;

/// Output a command's readers may still take after the program exited without waiting for the link: the pipe's tail.
const EXIT_ALLOWANCE: usize = 1024 * 1024;

/// `Gate::allowance` while the program runs.
const RUNNING: usize = usize::MAX;

#[derive(Default)]
struct Queues {
    control: VecDeque<Frame>,
    bulk: VecDeque<(Frame, Option<Arc<AtomicUsize>>)>,
    bulk_bytes: usize,
    closed: bool,
}

#[derive(Default)]
pub struct Output {
    queues: Mutex<Queues>,
    /// Signalled when a frame is queued or the writer stops.
    queued: Condvar,
    /// Signalled when bulk bytes were written.
    drained: Condvar,
}

impl Output {
    pub fn control(&self, frame: Frame) {
        let mut queues = self.queues.lock().unwrap();
        queues.control.push_back(frame);
        self.queued.notify_one();
    }

    /// Queue bulk output; `unsent` counts this sender's frames until they are written.
    pub fn bulk(&self, frame: Frame, unsent: Option<Arc<AtomicUsize>>) {
        let mut queues = self.queues.lock().unwrap();
        queues.bulk_bytes += frame.payload.len();
        if let Some(counter) = &unsent {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        queues.bulk.push_back((frame, unsent));
        self.queued.notify_one();
    }

    /// Wait while more than the bulk limit is unsent, unless `stop` is set or `released` holds.
    fn wait_for_room(&self, stop: &AtomicBool, released: impl Fn() -> bool) {
        let mut queues = self.queues.lock().unwrap();
        while queues.bulk_bytes > BULK_LIMIT
            && !queues.closed
            && !stop.load(Ordering::SeqCst)
            && !released()
        {
            queues = self
                .drained
                .wait_timeout(queues, Duration::from_millis(100))
                .unwrap()
                .0;
        }
    }

    /// Wake readers waiting for room so they look at their release condition again.
    fn wake(&self) {
        let _queues = self.queues.lock().unwrap();
        self.drained.notify_all();
    }

    pub fn close(&self) {
        let mut queues = self.queues.lock().unwrap();
        queues.closed = true;
        self.queued.notify_all();
        self.drained.notify_all();
    }

    /// Write frames to `writer` until closed or a write fails.
    pub fn run(&self, writer: &mut impl Write) {
        loop {
            let (frame, unsent) = {
                let mut queues = self.queues.lock().unwrap();
                loop {
                    if let Some(frame) = queues.control.pop_front() {
                        break (frame, None);
                    }
                    if let Some((frame, unsent)) = queues.bulk.pop_front() {
                        queues.bulk_bytes -= frame.payload.len();
                        break (frame, unsent);
                    }
                    if queues.closed {
                        return;
                    }
                    queues = self.queued.wait(queues).unwrap();
                }
            };
            let failed = frame::write_frame(writer, &frame).is_err();
            if let Some(counter) = unsent {
                counter.fetch_sub(1, Ordering::SeqCst);
            }
            self.drained.notify_all();
            if failed {
                self.close();
                return;
            }
        }
    }
}

/// Backpressure for the readers of one command: like a full pipe, a reader that read a chunk waits for room before it
/// reads the next. A reader counts as held while it hands a chunk over and waits, so the command can tell a reader the
/// link holds up from a pipe that went silent.
///
/// Downstream: once the program exited, readers take the pipe's tail without waiting for the link, up to
/// `EXIT_ALLOWANCE`. A reader the link holds up past that is not held output, so a client that stops reading cannot
/// keep a finished command alive; the command ends at its silence deadline as before upstream b48c675a.
#[derive(Clone)]
pub struct Gate {
    output: Arc<Output>,
    held: Arc<AtomicUsize>,
    /// Bytes readers may still take without waiting after the program exited, or `RUNNING`.
    allowance: Arc<AtomicUsize>,
}

impl Gate {
    pub fn new(output: &Arc<Output>) -> Gate {
        Gate {
            output: output.clone(),
            held: Arc::new(AtomicUsize::new(0)),
            allowance: Arc::new(AtomicUsize::new(RUNNING)),
        }
    }

    /// Run `deliver` for a chunk of `len` bytes just read, then wait for room unless `stop` is set; returns what
    /// `deliver` returned.
    pub fn pass(&self, stop: &AtomicBool, len: usize, deliver: impl FnOnce() -> bool) -> bool {
        self.held.fetch_add(1, Ordering::SeqCst);
        let delivered = deliver();
        if self.allowance.load(Ordering::SeqCst) == RUNNING {
            // The program's exit releases the wait: the pipe's tail is read next.
            self.output
                .wait_for_room(stop, || self.allowance.load(Ordering::SeqCst) != RUNNING);
            self.held.fetch_sub(1, Ordering::SeqCst);
        } else {
            self.held.fetch_sub(1, Ordering::SeqCst);
            let taken = self
                .allowance
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(len)
                })
                .is_ok();
            if !taken {
                self.output.wait_for_room(stop, || false);
            }
        }
        delivered
    }

    /// The program exited: release readers waiting for room and let them take the pipe's tail.
    pub fn exit(&self) {
        let _ = self.allowance.compare_exchange(
            RUNNING,
            EXIT_ALLOWANCE,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        self.output.wake();
    }

    /// Whether a reader is handing over a chunk or waiting for room: its silence is not the end of the output.
    pub fn held(&self) -> bool {
        self.held.load(Ordering::SeqCst) > 0
    }
}
