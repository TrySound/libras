import { installLanding } from "./landing-installation";

const cleanup = installLanding();
if (import.meta.hot) import.meta.hot.dispose(cleanup);
