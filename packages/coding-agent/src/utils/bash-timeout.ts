// Only interactive Ctrl-Z pauses these timers. Do not install a SIGTSTP listener:
// doing so would suppress Node's default job-control stop.
const timeouts = new Set<{ pause: () => void; resume: () => void }>();
let suspended = false;

export function resumeBashTimeouts(): void {
	if (!suspended) return;
	suspended = false;
	process.removeListener("SIGCONT", resumeBashTimeouts);
	for (const timer of timeouts) timer.resume();
}

export function pauseBashTimeouts(): void {
	if (suspended || process.platform === "win32") return;
	suspended = true;
	for (const timer of timeouts) timer.pause();
	process.once("SIGCONT", resumeBashTimeouts);
}

export function bashTimeout(callback: () => void, milliseconds: number): () => void {
	let remaining = milliseconds;
	let started = performance.now();
	let handle: NodeJS.Timeout | undefined;
	let paused = suspended;
	const dispose = () => {
		clearTimeout(handle);
		timeouts.delete(timer);
	};
	const arm = () => {
		started = performance.now();
		handle = setTimeout(() => {
			dispose();
			callback();
		}, remaining);
	};
	const timer = {
		pause: () => {
			if (paused) return;
			paused = true;
			remaining = Math.max(0, remaining - (performance.now() - started));
			clearTimeout(handle);
		},
		resume: () => {
			if (!paused) return;
			paused = false;
			arm();
		},
	};
	timeouts.add(timer);
	if (!paused) arm();
	return dispose;
}
