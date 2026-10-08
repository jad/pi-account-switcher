import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AccountSwitcher } from "../../runtime";
import { useReposCommand } from "./repos";

const useReposCommands = (pi: ExtensionAPI, runtime: AccountSwitcher) => {
  useReposCommand(pi, runtime);
};

export default useReposCommands;
