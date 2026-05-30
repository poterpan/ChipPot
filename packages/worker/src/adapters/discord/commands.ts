// The persistent payment button's custom_id (action:workspace:version).
export const PAY_BUTTON_PREFIX = "chippot:pay";

// Discord option types we use.
export const OPT_STRING = 3;
export const OPT_ATTACHMENT = 11;

// Interaction types.
export const IT_PING = 1;
export const IT_COMMAND = 2;
export const IT_COMPONENT = 3;
export const IT_AUTOCOMPLETE = 4;

// Interaction response types.
export const RT_PONG = 1;
export const RT_MESSAGE = 4;
export const RT_DEFERRED = 5;
export const RT_AUTOCOMPLETE = 8;

export const FLAG_EPHEMERAL = 64;

/** The persistent payment message's button action row. custom_id = action:workspace:version. */
export function payButtonRow(workspaceId = 1, version = "v1") {
  return {
    type: 1,
    components: [{ type: 2, style: 1, label: "繳費", custom_id: `${PAY_BUTTON_PREFIX}:${workspaceId}:${version}` }],
  };
}

/** `/繳費` command registration payload. */
export const PAY_COMMAND = {
  name: "繳費",
  type: 1,
  description: "登記本期繳費（可選擇附上截圖）",
  options: [
    { type: OPT_STRING, name: "方案", description: "有多筆訂閱時選擇方案", autocomplete: true, required: false },
    { type: OPT_ATTACHMENT, name: "截圖", description: "繳費截圖（PNG / JPG / WebP）", required: false },
    { type: OPT_STRING, name: "備註", description: "備註（自由文字，僅供審核參考）", required: false },
  ],
};
