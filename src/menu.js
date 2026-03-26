import { createMenu } from "./api-client.js";

export const MENU_KEY_MAP = {
  CMD_NEW: "/new",
  CMD_CLEAR: "/clear",
  CMD_HELP: "/help",
  CMD_STATUS: "/status",
  CMD_REASONING: "/reasoning",
  CMD_ABOUT: "/about",
  CMD_FEEDBACK: "/feedback",
  CMD_RESTART: "/restart",
};

const MENU_DEFINITION = {
  button: [
    {
      name: "\u5bf9\u8bdd",
      sub_button: [
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
          name: "\u72b6\u6001",
          key: "CMD_STATUS",
        },
      ],
    },
    {
      name: "\u8bbe\u7f6e",
      sub_button: [
        {
          type: "click",
          name: "\u5e2e\u52a9",
          key: "CMD_HELP",
        },
        {
          type: "click",
          name: "\u63a8\u7406\u6a21\u5f0f",
          key: "CMD_REASONING",
        },
        {
          type: "click",
          name: "\u53cd\u9988",
          key: "CMD_FEEDBACK",
        },
        {
          type: "click",
          name: "\u91cd\u542f\u7f51\u5173",
          key: "CMD_RESTART",
        },
      ],
    },
  ],
};

export async function createAgentMenu({ cfg, logger }) {
  return createMenu({ cfg, menuDef: MENU_DEFINITION, logger });
}
