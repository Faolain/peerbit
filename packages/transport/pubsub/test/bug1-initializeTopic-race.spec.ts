import { TestSession } from "@peerbit/libp2p-test-utils";
import { waitForNeighbour } from "@peerbit/stream";
import { waitForResolved } from "@peerbit/time";
import { expect } from "chai";
import { DirectSub } from "../src/index.js";

/**
 * Regression: `DirectSub.subscribe()` is debounced, but we still must initialize topic tracking
 * synchronously. Otherwise, incoming `Subscribe` messages can arrive before `_subscribe()` runs
 * and be dropped because `topics.get(topic)` is undefined.
 */
describe("BUG: initializeTopic race", function () {
	this.timeout(20_000);

	it("initializes topic tracking immediately on subscribe() (before debounce fires)", async () => {
		const session = (await TestSession.disconnected(1, {
			services: {
				pubsub: (c) =>
					new DirectSub(c, {
						canRelayMessage: true,
						connectionManager: false,
					}),
			},
		})) as TestSession<{ pubsub: DirectSub }>;

		try {
			const a = session.peers[0].services.pubsub;
			const TOPIC = "bug-initTopic-immediate";

			// Don't await; we want to assert the synchronous side effects of subscribe().
			const pending = a.subscribe(TOPIC);

			expect(a.topics.has(TOPIC)).to.equal(true);
			expect(a.topics.get(TOPIC)).to.be.instanceof(Map);

			await pending;
		} finally {
			await session.stop();
		}
	});

	it("subscribe and connect concurrently does not miss remote subscription", async () => {
		const session = (await TestSession.disconnected(2, {
			services: {
				pubsub: (c) =>
					new DirectSub(c, {
						canRelayMessage: true,
						connectionManager: false,
					}),
			},
		})) as TestSession<{ pubsub: DirectSub }>;

		try {
			const a = session.peers[0].services.pubsub;
			const b = session.peers[1].services.pubsub;
			const TOPIC = "bug-initTopic-subscribe-connect";

			// Subscribe before connecting; subscriptions will be sent during connect/join.
			await Promise.all([a.subscribe(TOPIC), b.subscribe(TOPIC)]);

			await session.connect([[session.peers[0], session.peers[1]]]);
			await waitForNeighbour(a, b);

			await waitForResolved(() => {
				expect(a.topics.get(TOPIC)?.has(b.publicKeyHash)).to.equal(true);
				expect(b.topics.get(TOPIC)?.has(a.publicKeyHash)).to.equal(true);
			});
		} finally {
			await session.stop();
		}
	});

	it("subscribe after connect still works", async () => {
		const session = (await TestSession.disconnected(2, {
			services: {
				pubsub: (c) =>
					new DirectSub(c, {
						canRelayMessage: true,
						connectionManager: false,
					}),
			},
		})) as TestSession<{ pubsub: DirectSub }>;

		try {
			const a = session.peers[0].services.pubsub;
			const b = session.peers[1].services.pubsub;
			const TOPIC = "bug-initTopic-subscribe-after-connect";

			await session.connect([[session.peers[0], session.peers[1]]]);
			await waitForNeighbour(a, b);

			await Promise.all([a.subscribe(TOPIC), b.subscribe(TOPIC)]);

			await waitForResolved(() => {
				expect(a.topics.get(TOPIC)?.has(b.publicKeyHash)).to.equal(true);
				expect(b.topics.get(TOPIC)?.has(a.publicKeyHash)).to.equal(true);
			});
		} finally {
			await session.stop();
		}
	});
});
