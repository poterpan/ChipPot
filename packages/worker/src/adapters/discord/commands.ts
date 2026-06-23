// The persistent payment button's custom_id (action:workspace:version).
export const PAY_BUTTON_PREFIX = "chippot:pay";
// The channel string-select shown after the button (action:workspace:period).
export const PAY_SELECT_PREFIX = "chippot:paysel";
// The period string-select shown when the member owes more than one opened period (action:workspace).
export const PAY_PERIOD_PREFIX = "chippot:payperiod";
// The 發起繳費 modal (action:workspace:period). Text inputs use custom_id `amt:<plan_id>`.
export const INITIATE_MODAL_PREFIX = "chippot:initiate";
// The self-bind string-select (action:workspace:origin). origin ∈ {pay, cmd}.
export const BIND_SELECT_PREFIX = "chippot:bind";
// Persistent public bind button. MUST NOT be "chippot:bind" (would collide with BIND_SELECT_PREFIX);
// dispatch checks this BEFORE BIND_SELECT_PREFIX because "chippot:bindbtn…" startsWith "chippot:bind".
export const BIND_BUTTON_PREFIX = "chippot:bindbtn";

// Discord option types we use.
export const OPT_STRING = 3;
export const OPT_ATTACHMENT = 11;

// Interaction types.
export const IT_PING = 1;
export const IT_COMMAND = 2;
export const IT_COMPONENT = 3;
export const IT_AUTOCOMPLETE = 4;
export const IT_MODAL_SUBMIT = 5;

// Interaction response types.
export const RT_PONG = 1;
export const RT_MESSAGE = 4;
export const RT_DEFERRED = 5;
export const RT_UPDATE_MESSAGE = 7; // edit the component's source (ephemeral) message
export const RT_AUTOCOMPLETE = 8;
export const RT_MODAL = 9;

// Component types.
export const CT_ACTION_ROW = 1;
export const CT_BUTTON = 2;
export const CT_STRING_SELECT = 3;
export const CT_TEXT_INPUT = 4;

export const FLAG_EPHEMERAL = 64;

// MANAGE_GUILD bit (UI filter only; real authorization is the admin_discord_ids whitelist).
export const MANAGE_GUILD = "32";

/** The persistent payment message's button action row. custom_id = action:workspace:version. */
export function payButtonRow(workspaceId = 1, version = "v1") {
  return {
    type: CT_ACTION_ROW,
    components: [{ type: CT_BUTTON, style: 1, label: "繳費", custom_id: `${PAY_BUTTON_PREFIX}:${workspaceId}:${version}` }],
  };
}

/** Persistent public "綁定 Discord" button row. custom_id = action:workspace. */
export function bindButtonRow(workspaceId = 1) {
  return {
    type: CT_ACTION_ROW,
    components: [{ type: CT_BUTTON, style: 2, label: "綁定 Discord", custom_id: `${BIND_BUTTON_PREFIX}:${workspaceId}` }],
  };
}

/** String-select of payable periods (months), shown when the member owes more than one. */
export function periodSelectRow(workspaceId: number, periods: string[]) {
  return {
    type: CT_ACTION_ROW,
    components: [{
      type: CT_STRING_SELECT,
      custom_id: `${PAY_PERIOD_PREFIX}:${workspaceId}`,
      placeholder: "選擇要繳的月份",
      min_values: 1,
      max_values: 1,
      options: periods.slice(0, 25).map((p) => ({ label: p, value: p })),
    }],
  };
}

/** String-select of active channel tags, shown after the button. */
export function channelSelectRow(
  workspaceId: number,
  period: string,
  tags: { id: number; name: string }[]
) {
  return {
    type: CT_ACTION_ROW,
    components: [{
      type: CT_STRING_SELECT,
      custom_id: `${PAY_SELECT_PREFIX}:${workspaceId}:${period}`,
      placeholder: "選擇繳費渠道",
      min_values: 1,
      max_values: 1,
      options: tags.slice(0, 25).map((t) => ({ label: t.name, value: String(t.id) })),
    }],
  };
}

/** String-select of unbound members for self-binding. origin drives the post-bind action. */
export function bindSelectRow(
  workspaceId: number,
  origin: "pay" | "cmd",
  users: { id: number; display_name: string }[]
) {
  return {
    type: CT_ACTION_ROW,
    components: [{
      type: CT_STRING_SELECT,
      custom_id: `${BIND_SELECT_PREFIX}:${workspaceId}:${origin}`,
      placeholder: "選擇你的名字",
      min_values: 1,
      max_values: 1,
      options: users.slice(0, 25).map((u) => ({ label: u.display_name, value: String(u.id) })),
    }],
  };
}

/** Modal for 發起繳費: one text input per active plan, pre-filled with its current price. */
export function initiateModal(
  workspaceId: number,
  period: string,
  plans: { id: number; name: string; monthly_amount: number }[]
) {
  return {
    type: RT_MODAL,
    data: {
      custom_id: `${INITIATE_MODAL_PREFIX}:${workspaceId}:${period}`,
      title: `發起繳費 ${period}`,
      components: plans.slice(0, 5).map((p) => ({
        type: CT_ACTION_ROW,
        components: [{
          type: CT_TEXT_INPUT,
          custom_id: `amt:${p.id}`,
          label: `${p.name} 金額 (NT$)`,
          style: 1, // short
          value: String(p.monthly_amount),
          required: true,
          min_length: 1,
          max_length: 7,
        }],
      })),
    },
  };
}

/** `/繳費` command registration payload. */
export const PAY_COMMAND = {
  name: "繳費",
  type: 1,
  description: "登記本期繳費（一次涵蓋你所有訂閱，可選渠道／截圖／備註）",
  options: [
    { type: OPT_STRING, name: "渠道", description: "繳費渠道", autocomplete: true, required: false },
    { type: OPT_ATTACHMENT, name: "截圖", description: "繳費截圖（PNG / JPG / WebP）", required: false },
    { type: OPT_STRING, name: "備註", description: "備註（自由文字，僅供審核參考）", required: false },
  ],
};

/** `/發起繳費` command registration payload (admin-only; real auth = admin_discord_ids). */
export const INITIATE_COMMAND = {
  name: "發起繳費",
  type: 1,
  description: "（管理員）確認本期各方案金額並發出開繳通知",
  default_member_permissions: MANAGE_GUILD,
};

/** `/綁定` command registration payload. */
export const BIND_COMMAND = {
  name: "綁定",
  type: 1,
  description: "把你的 Discord 帳號綁定到名單上的成員",
};
