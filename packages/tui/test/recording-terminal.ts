import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { VirtualTerminal } from "./virtual-terminal.ts";

interface SynchronizedReleaseState {
	row: number;
	column: number;
	cursorVisible: boolean;
}

interface CursorVisibilityTransition {
	cursorVisible: boolean;
	synchronizedOutput: boolean;
}

type PartialWriteSplit = (data: string) => number;
type WriteChunks = (data: string) => readonly string[];

export class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];
	private synchronizedReleaseStates: SynchronizedReleaseState[] = [];
	private cursorVisibilityTransitions: CursorVisibilityTransition[] = [];
	private cursorVisible = true;
	private synchronizedOutput = false;
	private failNextWrite = false;
	private partialWriteSplit: PartialWriteSplit | undefined;

	constructor(columns = 80, rows = 24) {
		super(columns, rows);
		const xterm = (this as unknown as { xterm: XtermTerminalType }).xterm;
		xterm.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
			for (const param of params) {
				if (typeof param !== "number") continue;
				if (param === 2026) {
					this.synchronizedOutput = true;
				} else if (param === 25) {
					this.cursorVisible = true;
					this.cursorVisibilityTransitions.push({
						cursorVisible: this.cursorVisible,
						synchronizedOutput: this.synchronizedOutput,
					});
				}
			}
			return false;
		});
		xterm.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
			for (const param of params) {
				if (typeof param !== "number") continue;
				if (param === 2026 && this.synchronizedOutput) {
					this.synchronizedOutput = false;
					this.synchronizedReleaseStates.push({
						row: xterm.buffer.active.cursorY,
						column: xterm.buffer.active.cursorX,
						cursorVisible: this.cursorVisible,
					});
				} else if (param === 25) {
					this.cursorVisible = false;
					this.cursorVisibilityTransitions.push({
						cursorVisible: this.cursorVisible,
						synchronizedOutput: this.synchronizedOutput,
					});
				}
			}
			return false;
		});
	}

	override write(data: string): void {
		if (this.failNextWrite) {
			this.failNextWrite = false;
			throw new Error("injected terminal write failure");
		}
		if (this.partialWriteSplit) {
			const split = this.partialWriteSplit;
			this.partialWriteSplit = undefined;
			const prefixLength = split(data);
			if (!Number.isInteger(prefixLength) || prefixLength <= 0 || prefixLength >= data.length) {
				throw new Error("partial terminal write split must select a non-empty proper prefix");
			}
			this.deliver(data.slice(0, prefixLength));
			throw new Error("injected partial terminal write failure");
		}
		this.writes.push(data);
		this.deliver(data);
	}

	protected deliver(data: string): void {
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	getAcceptedWriteCount(): number {
		return this.writes.length;
	}

	getAcceptedByteCount(): number {
		return this.writes.reduce((count, write) => count + Buffer.byteLength(write), 0);
	}

	clearWrites(): void {
		this.writes = [];
	}

	getFullClearCount(): number {
		return this.writes.reduce((count, write) => count + (write.match(/\x1b\[(?:2|3)J/g)?.length ?? 0), 0);
	}

	movePhysicalCursorTo(row: number, column: number): void {
		const xterm = (this as unknown as { xterm: XtermTerminalType }).xterm;
		xterm.write(`\x1b[${row + 1};${column + 1}H`);
	}

	injectWriteFailure(): void {
		this.failNextWrite = true;
	}

	injectPartialWriteFailure(split: PartialWriteSplit): void {
		this.partialWriteSplit = split;
	}

	isSynchronizedOutputActive(): boolean {
		return this.synchronizedOutput;
	}

	getSynchronizedReleaseStates(): readonly SynchronizedReleaseState[] {
		return this.synchronizedReleaseStates;
	}

	clearSynchronizedReleaseStates(): void {
		this.synchronizedReleaseStates = [];
	}

	getCursorVisibilityTransitions(): readonly CursorVisibilityTransition[] {
		return this.cursorVisibilityTransitions;
	}

	isCursorVisible(): boolean {
		return this.cursorVisible;
	}

	clearCursorVisibilityTransitions(): void {
		this.cursorVisibilityTransitions = [];
	}
}

export class ControlledDeliveryTerminal extends LoggingVirtualTerminal {
	private pendingWrites: string[] = [];

	protected override deliver(data: string): void {
		this.pendingWrites.push(data);
	}

	deliverAcceptedWrites(chunks: WriteChunks = (data) => [data]): void {
		const pendingWrites = this.pendingWrites;
		this.pendingWrites = [];
		for (const write of pendingWrites) {
			for (const chunk of chunks(write)) {
				super.deliver(chunk);
			}
		}
	}
}
