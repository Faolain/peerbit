// get monorepo root location using esm and .git folder
import * as findUp from "find-up";
import path from "path";

const gitDir = await findUp.findUp(".git", { type: "directory" });
const gitFile = gitDir ? null : await findUp.findUp(".git", { type: "file" });
const root = path.dirname(gitDir ?? gitFile);

export default {
	// global options
	debug: false,
	test: {
		/* concurrency: 2, */
		files: [],
		before: () => {
			return {
				env: { TS_NODE_PROJECT: path.join(root, "tsconfig.test.json") },
			};
		},
	},
};
