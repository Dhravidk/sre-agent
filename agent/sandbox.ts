import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

// The lab exposes no shell tool. This virtual filesystem avoids Docker or
// cloud sandbox provisioning when building the optional reasoning adapter.
export const environment = JustBashSandbox.environment({ autoInstall: false });
export default defineSandbox(() => environment.open());
