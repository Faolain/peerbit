import { SearchRequest } from "@peerbit/document-interface";
import { MissingResponsesError } from "@peerbit/rpc";
import { TestSession } from "@peerbit/test-utils";
import { delay, waitForResolved } from "@peerbit/time";
import { expect } from "chai";
import { Documents } from "../src/program.js";
import { Document, TestStore } from "./data.js";

describe("strict search under churn", () => {
	let session: TestSession | undefined;

	afterEach(async () => {
		if (session) {
			await session.stop();
			session = undefined;
		}
	});

	it("eventually returns complete results with strict mitigations", async () => {
		session = await TestSession.connected(2);

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
			timeout: 10_000,
			throwOnMissing: true,
			reach: {
				discover: [session.peers[1].identity.publicKey],
			},
			wait: {
				timeout: 8_000,
				behavior: "block" as const,
				until: "any" as const,
				onTimeout: "error" as const,
			},
		};

		const request = new SearchRequest({ query: [] });
		const baseline = await store1.docs.index.search(request, {
			remote: remoteOptions,
		});
		expect(baseline).to.have.length(count);

		await session.peers[1].stop();

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

		const results = await strictSearchWithRetries({
			attempts: 4,
			baseDelay: 250,
		});
		await restartPromise;
		expect(results).to.have.length(count);
	});
});
