import { SearchRequest } from "@peerbit/document-interface";
import { MissingResponsesError } from "@peerbit/rpc";
import { TestSession } from "@peerbit/test-utils";
import { delay, waitForResolved } from "@peerbit/time";
import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Documents } from "../src/program.js";
import { Document, TestStore } from "./data.js";

describe("strict search under churn", () => {
	let session: TestSession | undefined;
	let tempDir: string | undefined;

	afterEach(async () => {
		if (session) {
			await session.stop();
			session = undefined;
		}
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("eventually returns complete results with strict mitigations", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "peerbit-churn-"));
		const peer1Dir = path.join(tempDir, "peer1");
		const peer2Dir = path.join(tempDir, "peer2");
		await Promise.all([
			fs.mkdir(peer1Dir, { recursive: true }),
			fs.mkdir(peer2Dir, { recursive: true }),
		]);

		// Use on-disk blocks so that stop/start resembles production restart (no data loss).
		session = await TestSession.connected(2, [
			{ directory: peer1Dir },
			{ directory: peer2Dir },
		]);

		const store1 = new TestStore({
			docs: new Documents<Document>(),
		});
		await session.peers[0].open(store1, {
			args: {
				replicate: { offset: 0, factor: 0.5 },
				replicas: { min: 1 },
				timeUntilRoleMaturity: 0,
			},
		});

		let store2 = await session.peers[1].open(store1.clone(), {
			args: {
				replicate: { offset: 0.5, factor: 0.5 },
				replicas: { min: 1 },
				timeUntilRoleMaturity: 0,
			},
		});

		const count = 200;
		for (let i = 0; i < count; i++) {
			await store1.docs.put(
				new Document({ id: i.toString(), number: BigInt(i) }),
			);
		}

		await waitForResolved(() =>
			expect(store2.docs.log.log.length).to.be.greaterThan(0),
		);
		await waitForResolved(() =>
			expect(store1.docs.log.log.length).to.be.lessThan(count),
		);

		const remoteOptions = {
			timeout: 15_000,
			throwOnMissing: true,
		};

		const request = new SearchRequest({ query: [], fetch: count });
		const localOnly = await store1.docs.index.search(request, { remote: false });
		expect(localOnly.length).to.be.lessThan(count);

		const baseline = await store1.docs.index.search(request, {
			remote: remoteOptions,
		});
		expect(baseline).to.have.length(count);

		await session.peers[1].stop();

		// During churn, a strict client can either:
		// - throw on missing responders (throwOnMissing=true), or
		// - detect a short read and retry until reachability/convergence is restored.
		try {
			const downResults = await store1.docs.index.search(request, {
				remote: { ...remoteOptions, timeout: 250 },
			});
			expect(downResults.length).to.be.lessThan(count);
		} catch (error) {
			expect(error).to.be.instanceOf(MissingResponsesError);
		}

		const restartDelay = 800;
		const restartPromise = (async () => {
			await delay(restartDelay);
			await session!.peers[1].start();
			store2 = await session!.peers[1].open(store2.clone(), {
				args: {
					replicate: { offset: 0.5, factor: 0.5 },
					replicas: { min: 1 },
					timeUntilRoleMaturity: 0,
				},
			});
			await store2.docs.log.waitForReplicators();
		})();

		const strictSearchWithRetries = async (options: {
			attempts: number;
			baseDelay: number;
		}) => {
			let lastError: Error | undefined;
			for (let attempt = 0; attempt < options.attempts; attempt++) {
				try {
					const results = await store1.docs.index.search(request, {
						remote: remoteOptions,
					});
					if (results.length !== count) {
						throw new Error(
							`Strict search incomplete: expected ${count}, got ${results.length}`,
						);
					}
					return results;
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					if (attempt < options.attempts - 1) {
						await delay(options.baseDelay * 2 ** attempt);
					}
				}
			}

			const hint =
				lastError instanceof MissingResponsesError
					? "Missing responders for one or more shards."
					: "Timeout or incomplete results while waiting on remote shards.";
			throw new Error(
				`Strict distributed search failed after ${options.attempts} attempts. ${hint} Last error: ${lastError?.message}`,
			);
		};

		await restartPromise;
		const results = await strictSearchWithRetries({
			attempts: 6,
			baseDelay: 250,
		});
		expect(results).to.have.length(count);
	});
});
