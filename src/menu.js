import { createMenu } from "./api-client.js";

export const MENU_KEY_MAP = {
  CMD_NEW: "/new",
  CMD_CLEAR: "/clear",
  CMD_HELP: "/help",
};

const MENU_DEFINITION = {
  button: [
    {
      type: "click",
      name: "\u65b0\u5bf9\u8bdd",
      key: "CMD_NEW",
    },
    {
      type: "click",
      name: "\u6e05\u9664\u5386\u53f2",
      key: "CMD_CLEAR",
    },
    {
      type: "click",
      name: "\u5e2e\u52a9",
      key: "CMD_HELP",
    },
  ],
};

export async function createAgentMenu({ cfg, logger }) {
  return createMenu({ cfg, menuDef: MENU_DEFINITION, logger });
}
