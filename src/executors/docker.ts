import type { Executor, ExecResult, GrepMatch, RunOpts } from "./index.ts";

// Stub. Weekend 2 implementation — see GARY_SPEC.md §10. Bind-mounts the
// worktree into a container and proxies every Executor method through
// `docker exec`. Tools and the agent loop don't change.
export class DockerExecutor implements Executor {
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  readFile(_path: string): Promise<string> {
    throw new Error("DockerExecutor.readFile not implemented (Weekend 2)");
  }

  writeFile(_path: string, _content: string): Promise<void> {
    throw new Error("DockerExecutor.writeFile not implemented (Weekend 2)");
  }

  listFiles(_pattern: string): Promise<string[]> {
    throw new Error("DockerExecutor.listFiles not implemented (Weekend 2)");
  }

  grep(_pattern: string, _pathGlob?: string): Promise<GrepMatch[]> {
    throw new Error("DockerExecutor.grep not implemented (Weekend 2)");
  }

  run(_command: string, _opts?: RunOpts): Promise<ExecResult> {
    throw new Error("DockerExecutor.run not implemented (Weekend 2)");
  }
}
