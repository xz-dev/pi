## Purpose

Let interactive commands behave as shell jobs while retaining cleanup progress and restoring terminal state without interfering with unrelated foreground work.

## ADDED Requirements

### Requirement: Support interactive and redirected execution
Procward SHALL support a controlling Unix terminal and nonterminal stdio. Any interactive isolation SHALL preserve user input/output and separately redirected stderr, and SHALL NOT leak native control endpoints or unintended physical-terminal access into descendants. Noninteractive execution SHALL NOT require a PTY.

#### Scenario: Interactive stderr is redirected
- **WHEN** stdin/stdout use the same controlling terminal and stderr names a file
- **THEN** interaction works and stderr still reaches that file

#### Scenario: Command runs through pipes
- **WHEN** stdin/stdout are pipes rather than a controlling terminal
- **THEN** procward supervises without creating or seizing a physical terminal

### Requirement: Suspend and resume the owned job
On Unix, Ctrl-Z SHALL suspend shell-facing work and owned descendants supported by the backend while native cleanup remains runnable. Saved cooked terminal state SHALL be restored before yielding to the shell. `bg` SHALL resume private work without physical terminal access; `fg` SHALL restore access and continue work. Resume/freeze races SHALL NOT require an extra signal cycle to recover.

#### Scenario: Repeated Ctrl-Z and fg
- **WHEN** a fresh interactive fixture and detached worker are repeatedly suspended and foregrounded
- **THEN** their work stops during each pause, resumes after each foreground grant and does not stop unrelated shell jobs

#### Scenario: bg precedes fg
- **WHEN** a paused job is backgrounded and later foregrounded
- **THEN** background work cannot steal physical input/output and foreground access is restored without stale grants

### Requirement: Keep fatal cleanup independent of terminal progress
TERM/HUP, owner loss and terminal loss SHALL initiate irreversible cleanup even while the command or shell-facing process is stopped or output is blocked. Cleanup SHALL obey TERM-before-CONT policy and SHALL NOT issue a fresh healthy foreground grant. A shell reclaim or background tty syscall SHALL NOT trap every native cleanup role in another job-control stop.

#### Scenario: Owner dies while job is paused
- **WHEN** ordinary ownership roles are lost while an independent cleanup role survives
- **THEN** permitted shutdown wake and tree cleanup occur without `fg` within the fault teardown bound

#### Scenario: Shell reclaims a stalled terminal
- **WHEN** private output is blocked and unrelated work acquires the physical foreground
- **THEN** cleanup remains able to terminate/reap owned work and discard fatal output where needed

#### Scenario: Background read races foreground reclaim
- **WHEN** the relay observes itself foreground but the shell reclaims before its physical-terminal read
- **THEN** SIGTTIN interrupts that read and native cleanup keeps progressing within its original bound

### Requirement: Restore terminal state only with authority
On pause, normal exit and abnormal cleanup, surviving authorized native roles SHALL attempt terminal restoration only while a physical-terminal acquisition still owes restoration, using the snapshot saved at that acquisition rather than startup state. Restore or release SHALL clear that obligation; reacquisition SHALL capture current settings. The acquisition snapshot and write-ahead restoration intent SHALL survive anchor loss before raw-mode entry. Kernel modifying calls SHALL decide authority; mode equality, signal masking or a private-session physical write SHALL NOT bypass a denial. No claim SHALL be made that a killed process can execute its own cleanup after SIGKILL.

#### Scenario: Another job owns foreground
- **WHEN** cleanup tries terminal restoration after foreground ownership changed
- **THEN** procward respects kernel denial and does not overwrite the unrelated job's terminal state

#### Scenario: Shell-facing owner dies
- **WHEN** an authorized native survivor retains the terminal state needed for restoration
- **THEN** restoration is attempted without waiting for application hooks or the dead owner

#### Scenario: Anchor dies during raw-mode payload
- **WHEN** the anchor is killed while the shell-facing owner survives with foreground authority
- **THEN** the surviving owner cleans the tree, attempts the saved physical-terminal restoration and returns failure 125
- **AND** after unrelated foreground takeover, the same failover must not overwrite that job's state

#### Scenario: Anchor dies without acquiring raw mode
- **WHEN** procward starts in the background, its anchor is stopped before acquisition, the shell changes terminal settings, then foreground is handed to the outer and the anchor is killed
- **THEN** the newer settings remain untouched and procward returns failure 125

#### Scenario: Anchor dies after terminal release
- **WHEN** pause has restored and released the terminal, the shell changes settings, foreground is handed to the outer without reacquisition, then the anchor is killed
- **THEN** the released acquisition does not authorize restoration and the newer settings remain untouched with failure 125

#### Scenario: Anchor dies after reacquiring the terminal
- **WHEN** pause releases the terminal, the shell changes settings, procward reacquires raw mode on fg, then the anchor is killed
- **THEN** authorized failover restores the settings captured on reacquisition, not startup settings, and returns failure 125

### Requirement: Preserve normal output and interrupt handling
Normal completion SHALL deliver final output and preserve the primary result. Fatal cleanup SHALL interrupt tail waits and alone SHALL be allowed to discard pending output. Terminal Ctrl-C SHALL reach the command once, not be duplicated by forwarding. Native signal dispositions/masks SHALL NOT leak into payload exec.

#### Scenario: Command emits a final marker
- **WHEN** a fixture writes its final output marker and exits with status 23
- **THEN** the marker is visible before procward returns 23

#### Scenario: User presses Ctrl-C
- **WHEN** the command receives a terminal-generated interrupt
- **THEN** its handler observes one interrupt rather than duplicate delivery from procward

### Requirement: Preserve Windows console and ConPTY interaction
Windows SHALL support inherited console/ConPTY interaction and normal Ctrl-C/Break delivery alongside Job-backed cleanup. Unix Ctrl-Z/fg or termios guarantees SHALL NOT be advertised for Windows.

#### Scenario: ConPTY fixture handles interrupt then quits
- **WHEN** a fresh fixture reports handled Ctrl-C and then accepts quit through observed readiness
- **THEN** the interaction succeeds and its Job is cleaned up without duplicate or swallowed input
