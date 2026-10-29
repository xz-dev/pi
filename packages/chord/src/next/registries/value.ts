// Registry values (slice 8 §1 "Reading", S2, S3): a registry's composed value as the readers of one version see it, a
// native source. The provider's version reads the composition itself; an older one reads it mapped back with
// `accepts[old].value`, once per composition, kept only while someone reads or follows it; a version the provider
// cannot serve fails `contract_mismatch`. Readers declared by attempts are woken (R18) when the value gets its first
// good value.

import { ChordError } from "../data/index.ts";
import { type Batch, FollowedSource, type NativeStart } from "../state/internal.ts";
import type { RegistryRecord } from "./record.ts";

/** An object waiting for a registry's value (`self.registry`): retried at once when its first value arrives (R18). */
export interface RegistryWaiter {
	dependencyLive(): void;
}

/** The last good mapping for an older version, and the composition it was made from. */
type Mapped = { readonly from: unknown; readonly value: unknown };

/** A failed mapping of composition `from`, until another composition maps. */
type MapFailure = { readonly from: unknown; readonly error: unknown };

/**
 * Where a value's registry stands for it: on the host, or closed with the host (its last start kept, the record let
 * go, so a value an app keeps keeps no closed host).
 */
type Registered =
	| { readonly kind: "open"; readonly record: RegistryRecord }
	| { readonly kind: "closed"; readonly last: NativeStart<unknown> };

/** One version's view of a registry's composed value. */
export class RegistryValueSource extends FollowedSource<unknown> {
	readonly name: string;
	readonly version: number;
	#registered: Registered;
	/** Readers declared by attempts, each a token of its own (one object may read twice), until released. */
	readonly #readers = new Set<{ readonly waiter: RegistryWaiter }>();
	/** Whether it had a good value: the first one wakes the readers. */
	#valued = false;
	#mapped: Mapped | undefined;
	#mapFailure: MapFailure | undefined;

	constructor(record: RegistryRecord, version: number, batch: Batch) {
		super(batch);
		this.name = record.name;
		this.version = version;
		this.#registered = { kind: "open", record };
	}

	/** Its registry's record while the host is open. */
	get record(): RegistryRecord | undefined {
		const registered = this.#registered;
		return registered.kind === "open" ? registered.record : undefined;
	}

	/** The composition (or its mapping) at its last good value; throws the failure when there is none. */
	get value(): unknown {
		const start = this.start();
		if (start.kind === "value") return start.value;
		if (start.last === undefined) throw start.error;
		return start.last.value;
	}

	/** Its composition (mapped for an older version), composed now if its table changed; a first value wakes readers. */
	override start(): NativeStart<unknown> {
		const registered = this.#registered;
		if (registered.kind === "closed") return registered.last;
		const start = this.#start(registered.record);
		if (!this.#valued && (start.kind === "value" || start.last !== undefined)) {
			this.#valued = true;
			// Not inside the batch that composed: a retry runs a factory, which may not run in a batch.
			for (const { waiter } of this.#readers) queueMicrotask(() => waiter.dependencyLive());
		}
		return start;
	}

	/** Its composition (or mapping) now; throws while it is failed, though `.value` keeps the last good one. */
	override current(): unknown {
		const start = this.start();
		if (start.kind === "failed") throw start.error;
		return start.value;
	}

	/** Followed while someone watches or observes it, and while readers wait for its first value. */
	override get watched(): boolean {
		return super.watched || (this.#readers.size > 0 && !this.#valued);
	}

	/** Registers `waiter` (an activation's declared dependency) until the returned release. */
	read(waiter: RegistryWaiter): () => void {
		const token = { waiter };
		this.#readers.add(token);
		return () => {
			this.#readers.delete(token);
			if (this.#readers.size === 0 && !super.watched) this.#dropMapping();
		};
	}

	/** The registry's table changed (inside a batch): its dependents are marked, its followers get the next frame. */
	recomposed(): void {
		this.changed();
	}

	/**
	 * The registry's table changed again while not composed since (inside a batch): its dependents are marked already
	 * (none read it meanwhile, or it would be composed); its followers get the next frame. Marking stops here, so a
	 * cycle of registries through their values ends.
	 */
	relisted(): void {
		this.list();
	}

	/** The host closed: its watches and observers end, its readers and mapping go; it keeps its last start only. */
	close(): void {
		let last: NativeStart<unknown>;
		try {
			last = this.start();
		} catch (error) {
			last = { kind: "failed", error, last: undefined };
		}
		this.#registered = { kind: "closed", last };
		this.#readers.clear();
		this.#dropMapping();
		this.end();
	}

	/** Nobody follows it: without readers, its mapping goes (computed again on the next read). */
	protected override unfollowed(): void {
		if (this.#readers.size === 0) this.#dropMapping();
	}

	#dropMapping(): void {
		this.#mapped = undefined;
		this.#mapFailure = undefined;
	}

	#start(record: RegistryRecord): NativeStart<unknown> {
		const provided = record.providedVersion;
		if (provided === undefined || provided === this.version) return record.start();
		const map = provided > this.version ? record.valueAdapter(this.version) : undefined;
		if (map === undefined) {
			const message = `registry ${this.name}: version ${this.version} is not served here (version ${provided} is)`;
			return { kind: "failed", error: new ChordError({ code: "contract_mismatch", message }), last: undefined };
		}
		return this.#mappedStart(record, record.start(), map);
	}

	/**
	 * The composition `current` mapped back with `map`, once per composition; a throwing mapping fails this version
	 * only (reported once per episode), keeping its last good mapping; a composition mapped before heals it.
	 */
	#mappedStart(
		record: RegistryRecord,
		current: NativeStart<unknown>,
		map: (current: never) => unknown,
	): NativeStart<unknown> {
		if (current.kind === "failed" && current.last === undefined) return current;
		const from = current.kind === "value" ? current.value : current.last!.value;
		// `undefined` is a composition too: the records, not their fields, say whether there is one.
		const mapped = this.#mapped;
		const failure = this.#mapFailure;
		if (mapped !== undefined && mapped.from === from) {
			this.#mapFailure = undefined;
		} else if (failure === undefined || failure.from !== from) {
			try {
				this.#mapped = { from, value: record.adapt(() => map(from as never)) };
				this.#mapFailure = undefined;
			} catch (error) {
				if (failure === undefined) record.failed(error);
				this.#mapFailure = { from, error };
			}
		}
		const last = this.#mapped === undefined ? undefined : { value: this.#mapped.value };
		if (this.#mapFailure !== undefined) return { kind: "failed", error: this.#mapFailure.error, last };
		if (current.kind === "failed") return { kind: "failed", error: current.error, last };
		return { kind: "value", value: last!.value };
	}
}
