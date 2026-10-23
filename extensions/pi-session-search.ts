import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerResumeSearch } from "../src/command";
import { registerSessionSearchTool } from "../src/tool";

export default function sessionSearchExtension(pi: ExtensionAPI): void {
  registerResumeSearch(pi);
  registerSessionSearchTool(pi);
}
