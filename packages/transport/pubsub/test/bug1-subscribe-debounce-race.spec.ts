import { TestSession } from "@peerbit/libp2p-test-utils";
import { waitForNeighbour } from "@peerbit/stream";
import { SeekDelivery } from "@peerbit/stream-interface";
import { delay, waitForResolved } from "@peerbit/time";
import { expect } from "chai";
import { DirectSub } from "../src/index.js";

const deferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: any) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

describe("BUG: subscribe debounce race", function () {
	this.timeout(20_000);

	it("a pending debounced subscribe is advertised via Subscribe{requestSubscribers:true} response", async () => {
		const TOPIC = "pending-subscribe-visible";

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

			await session.connect([[session.peers[0], session.peers[1]]]);
			await waitForNeighbour(a, b);

			// Block A._subscribe() so that A remains "pending" (no `subscriptions` entry).
			const gate = deferred<void>();
			const aAny = a as any;
			const originalSubscribeImpl = aAny._subscribe.bind(aAny);
			aAny._subscribe = async (...args: any[]) => {
				await gate.promise;
				return originalSubscribeImpl(...args);
			};

			let aSubscribeDone = false;
			const aSubscribe = a.subscribe(TOPIC).then(() => {
				aSubscribeDone = true;
			});

			await b.subscribe(TOPIC);

			await waitForResolved(() => {
				expect(aSubscribeDone, "A.subscribe should still be pending").to.equal(false);
				expect(b.topics.get(TOPIC)?.has(a.publicKeyHash)).to.equal(true);
			});

			// Cleanup: allow A._subscribe to proceed so we don't leave dangling work.
			gate.resolve();
			await aSubscribe;
		} finally {
			await session.stop();
		}
	});

	it("incoming Subscribe is not dropped during the local debounce window (topic initialized in subscribe)", async () => {
		const TOPIC = "incoming-subscribe-not-dropped";

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

			await session.connect([[session.peers[0], session.peers[1]]]);
			await waitForNeighbour(a, b);

			// Block A._subscribe() to force A to remain in the debounce window.
			const gate = deferred<void>();
			const aAny = a as any;
			const originalSubscribeImpl = aAny._subscribe.bind(aAny);
			aAny._subscribe = async (...args: any[]) => {
				await gate.promise;
				return originalSubscribeImpl(...args);
			};

			// A is "pending subscribe" for TOPIC. The bug is that, without eager topic
			// init, A drops B's Subscribe message because `topics.get(TOPIC)` is undefined.
			const aSubscribe = a.subscribe(TOPIC);

			await b.subscribe(TOPIC);

			await waitForResolved(() => {
				expect(a.topics.get(TOPIC)?.has(b.publicKeyHash)).to.equal(true);
			});

			// Cleanup
			gate.resolve();
			await aSubscribe;
		} finally {
			await session.stop();
		}
	});

	it("subscribe then unsubscribe within debounce does not advertise or retain the topic", async () => {
		const TOPIC = "subscribe-unsubscribe-before-debounce";

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

			await session.connect([[session.peers[0], session.peers[1]]]);
			await waitForNeighbour(a, b);

			// Block A._subscribe() so A never reaches "subscriptions set" state.
			const gate = deferred<void>();
			const aAny = a as any;
			const originalSubscribeImpl = aAny._subscribe.bind(aAny);
			aAny._subscribe = async (...args: any[]) => {
				await gate.promise;
				return originalSubscribeImpl(...args);
			};

			// Start subscribe (pending) but don't await it; then cancel before debounce.
			const aSubscribe = a.subscribe(TOPIC).catch(() => {
				// Avoid unhandled rejections if cancellation rejects the promise.
			});
			await a.unsubscribe(TOPIC);

			await b.requestSubscribers(TOPIC, a.publicKey);
			await delay(250);

			expect(b.topics.get(TOPIC)?.has(a.publicKeyHash)).to.equal(false);
			expect(a.topics.has(TOPIC)).to.equal(false);

			// Cleanup
			gate.resolve();
			await aSubscribe;
		} finally {
			await session.stop();
		}
	});

	it("pending subscribe receives strict PubSubData", async () => {
		const TOPIC = "pending-subscribe-receives-pubsubdata";

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

			await session.connect([[session.peers[0], session.peers[1]]]);
			await waitForNeighbour(a, b);

			// Block A._subscribe() so that A remains "pending" (no `subscriptions` entry).
			const gate = deferred<void>();
			const aAny = a as any;
			const originalSubscribeImpl = aAny._subscribe.bind(aAny);
			aAny._subscribe = async (...args: any[]) => {
				await gate.promise;
				return originalSubscribeImpl(...args);
			};

			let received = false;
			const payload = new Uint8Array([1, 2, 3, 4]);

			const onData = (e: any) => {
				if (!e?.detail?.data) {
					return;
				}
				if (e.detail.data.topics?.includes(TOPIC)) {
					received = true;
				}
			};
			a.addEventListener("data", onData);

			// Start subscribe (pending), but keep it blocked in the debounce window.
			const aSubscribe = a.subscribe(TOPIC);

			// Publish a strict message to A. Without treating `pendingSubscriptions` as
			// local interest, A would incorrectly ignore this message.
			await b.publish(payload, {
				topics: [TOPIC],
				mode: new SeekDelivery({ redundancy: 1, to: [a.publicKeyHash] }),
			});

			await waitForResolved(() => {
				expect(received).to.equal(true);
			});

			// Cleanup
			a.removeEventListener("data", onData);
			gate.resolve();
			await aSubscribe;
		} finally {
			await session.stop();
		}
	});
});
