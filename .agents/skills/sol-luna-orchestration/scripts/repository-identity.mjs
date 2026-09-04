import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function resolveRepositoryIdentity(cwd) {
  const executionDirectory = await realpath(cwd);
  if (!(await stat(executionDirectory)).isDirectory()) throw new Error("Repository cwd must be a directory.");
  let root = executionDirectory;
  while (true) {
    try {
      await lstat(join(root, ".git"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (dirname(root) === root) {
        return { repository: executionDirectory, executionRepository: executionDirectory, commonGitDirectory: null, relatedRepositories: [] };
      }
      root = dirname(root);
    }
  }
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const options = { cwd: root, env: environment, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8" };
  const common = (await execute("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], options)).stdout.trim();
  const commonGitDirectory = await realpath(common);
  const output = (await execute("git", ["worktree", "list", "--porcelain", "-z"], options)).stdout;
  const relatedRepositories = output.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => resolve(field.slice(9)));
  if (relatedRepositories.length === 0) throw new Error("Git did not identify a primary checkout.");
  const repository = await realpath(relatedRepositories[0]);
  const executionRepository = await realpath(root);
  const normalize = (path) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (!relatedRepositories.some((path) => normalize(path) === normalize(executionRepository))) {
    throw new Error("Execution workspace is not registered in the common Git repository.");
  }
  return { repository, executionRepository, commonGitDirectory, relatedRepositories };
}
