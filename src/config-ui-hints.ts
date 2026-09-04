import {
  createChannelConfigUiHints,
  type ChannelConfigUiHint,
} from 'openclaw/plugin-sdk/channel-core';

const standardHints = createChannelConfigUiHints({
  channelLabel: 'XMPP',
  dmPolicy: { channelKey: 'xmpp' },
});

export const xmppConfigUiHints: Record<string, ChannelConfigUiHint> = {
  ...standardHints,
  '': {
    label: 'XMPP',
    help: 'Configure the default XMPP account or add named accounts under accounts.',
  },
  enabled: {
    label: 'Enabled',
    help: 'Enable this XMPP account.',
  },
  name: {
    label: 'Account Name',
    help: 'Optional display name for this account.',
  },
  jid: {
    label: 'XMPP JID',
    help: 'XMPP identity, for example bot@example.com. The logical XMPP domain is derived from this JID.',
    placeholder: 'bot@example.com',
  },
  password: {
    label: 'Password',
    help: 'Sensitive XMPP credential. Authentication is attempted only after STARTTLS succeeds.',
    sensitive: true,
  },
  server: {
    label: 'Connect Host',
    help: 'Optional physical TCP connect host. It does not change the logical XMPP domain; when omitted, the JID domain is used.',
    placeholder: 'example.com',
    advanced: true,
  },
  port: {
    label: 'TCP Port',
    help: 'Physical XMPP TCP port. The default is 5222.',
    advanced: true,
  },
  resource: {
    label: 'Resource',
    help: 'Optional XMPP resource identifier. A unique resource is generated when omitted.',
    advanced: true,
  },
  nickname: {
    label: 'MUC Nickname',
    help: 'Optional nickname used in configured rooms. The JID local part is used when omitted.',
    advanced: true,
  },
  dmPolicy: {
    ...standardHints.dmPolicy,
    help: 'Direct-message policy. The default is pairing, approvals are account-scoped, and open is an explicit choice.',
  },
  allowFrom: {
    label: 'Owner JIDs',
    help: 'Static owner bare JIDs.',
    placeholder: 'user@example.com',
  },
  dmAllowlist: {
    label: 'DM Allowlist',
    help: 'Additional bare JIDs admitted only when dmPolicy is allowlist.',
    placeholder: 'user@example.com',
  },
  groupPolicy: {
    label: 'Group Policy',
    help: 'Group-message policy. The default allowlist policy requires a verifiable real bare JID.',
  },
  groupAllowFrom: {
    label: 'Group Allowlist',
    help: 'Bare JIDs admitted in configured rooms. An empty list denies all senders under allowlist policy.',
    placeholder: 'user@example.com',
  },
  groups: {
    label: 'Configured Rooms',
    help: 'Only explicitly configured room JIDs are joined and processed.',
    placeholder: 'room@conference.example.com',
  },
  actions: {
    label: 'Actions',
    help: 'Optional XMPP message actions.',
    advanced: true,
  },
  'actions.reactions': {
    label: 'Reactions',
    help: 'Enable XEP-0444 message reactions.',
    advanced: true,
  },
  sendReadReceipts: {
    label: 'Read Markers',
    help: 'Send XEP-0333 displayed markers for authorized direct messages.',
    advanced: true,
  },
  heartbeatVisibility: {
    label: 'Heartbeat Visibility',
    help: 'Control which heartbeat results OpenClaw exposes for this account.',
    advanced: true,
  },
  'heartbeatVisibility.showOk': {
    label: 'Show Heartbeat OK',
    help: 'Show successful HEARTBEAT_OK acknowledgements.',
    placeholder: 'Inherit OpenClaw setting',
    advanced: true,
  },
  'heartbeatVisibility.showAlerts': {
    label: 'Show Heartbeat Alerts',
    help: 'Show heartbeat alerts that carry actual content.',
    placeholder: 'Inherit OpenClaw setting',
    advanced: true,
  },
  'heartbeatVisibility.useIndicator': {
    label: 'Use Heartbeat Indicator',
    help: 'Emit heartbeat status indicator events.',
    placeholder: 'Inherit OpenClaw setting',
    advanced: true,
  },
  groupSettings: {
    label: 'Group Settings',
    help: 'Per-room mention and tool policies keyed by room JID.',
    advanced: true,
  },
  accounts: {
    label: 'Named Accounts',
    help: 'Map of named XMPP accounts. Fields present in an account override the root setting; omitted fields inherit it.',
    advanced: true,
  },
  'accounts.*': {
    label: 'XMPP Account',
    help: 'Overrides for this named XMPP account. Leave fields unset to inherit their root settings.',
  },
  'accounts.*.enabled': {
    label: 'Enabled',
    help: 'Override whether this named account is enabled. Leave unset to inherit the root setting.',
    placeholder: 'Inherit root setting',
  },
  'accounts.*.name': {
    label: 'Account Name',
    help: 'Optional display-name override. Leave unset to inherit the root setting.',
  },
  'accounts.*.jid': {
    label: 'XMPP JID',
    help: 'XMPP identity override, for example bot@example.com. The logical XMPP domain is derived from the effective JID. Leave unset to inherit the root setting.',
    placeholder: 'bot@example.com',
  },
  'accounts.*.password': {
    label: 'Password',
    help: 'Sensitive XMPP credential override. Authentication is attempted only after STARTTLS succeeds. Leave unset to inherit the root setting.',
    sensitive: true,
  },
  'accounts.*.server': {
    label: 'Connect Host',
    help: 'Optional physical TCP connect-host override. It does not change the logical XMPP domain. Leave unset to inherit the root setting; if neither is set, the effective JID domain is used.',
    placeholder: 'example.com',
  },
  'accounts.*.port': {
    label: 'TCP Port',
    help: 'Physical XMPP TCP port override. Leave unset to inherit the root setting.',
  },
  'accounts.*.resource': {
    label: 'Resource',
    help: 'Optional XMPP resource override. Leave unset to inherit the root setting; a unique resource is generated when neither is set.',
  },
  'accounts.*.nickname': {
    label: 'MUC Nickname',
    help: 'Optional room-nickname override. Leave unset to inherit the root setting; the effective JID local part is used when neither is set.',
  },
  'accounts.*.dmPolicy': {
    label: 'XMPP DM Policy',
    help: 'Direct-message policy override. Pairing approvals are account-scoped and open is an explicit choice. Leave unset to inherit the root setting.',
  },
  'accounts.*.allowFrom': {
    label: 'Owner JIDs',
    help: 'Static owner bare JID override. Leave unset to inherit the root list; an empty list is an explicit empty override.',
    placeholder: 'user@example.com',
  },
  'accounts.*.dmAllowlist': {
    label: 'DM Allowlist',
    help: 'DM allowlist override. Leave unset to inherit the root list; an empty list explicitly admits no additional JIDs.',
    placeholder: 'user@example.com',
  },
  'accounts.*.groupPolicy': {
    label: 'Group Policy',
    help: 'Group-message policy override. Allowlist requires a verifiable real bare JID. Leave unset to inherit the root setting.',
  },
  'accounts.*.groupAllowFrom': {
    label: 'Group Allowlist',
    help: 'Group allowlist override. Leave unset to inherit the root list; an empty list denies all senders under allowlist policy.',
    placeholder: 'user@example.com',
  },
  'accounts.*.groups': {
    label: 'Configured Rooms',
    help: 'Configured-room override. Leave unset to inherit root rooms; an empty list explicitly configures no rooms.',
    placeholder: 'room@conference.example.com',
  },
  'accounts.*.actions': {
    label: 'Actions',
    help: 'Optional XMPP message-action override. Leave unset to inherit the root setting.',
  },
  'accounts.*.actions.reactions': {
    label: 'Reactions',
    help: 'Override XEP-0444 message reactions for this account. Leave unset to inherit the root setting.',
  },
  'accounts.*.sendReadReceipts': {
    label: 'Read Markers',
    help: 'Override XEP-0333 displayed markers for authorized direct messages. Leave unset to inherit the root setting.',
    placeholder: 'Inherit root setting',
  },
  'accounts.*.heartbeatVisibility': {
    label: 'Heartbeat Visibility',
    help: 'Heartbeat-visibility override. Leave unset to inherit the root setting.',
    advanced: true,
  },
  'accounts.*.heartbeatVisibility.showOk': {
    label: 'Show Heartbeat OK',
    help: 'Show successful HEARTBEAT_OK acknowledgements. Leave unset to inherit the root setting.',
    placeholder: 'Inherit root setting',
    advanced: true,
  },
  'accounts.*.heartbeatVisibility.showAlerts': {
    label: 'Show Heartbeat Alerts',
    help: 'Show heartbeat alerts that carry actual content. Leave unset to inherit the root setting.',
    placeholder: 'Inherit root setting',
    advanced: true,
  },
  'accounts.*.heartbeatVisibility.useIndicator': {
    label: 'Use Heartbeat Indicator',
    help: 'Emit heartbeat status indicator events. Leave unset to inherit the root setting.',
    placeholder: 'Inherit root setting',
    advanced: true,
  },
  'accounts.*.groupSettings': {
    label: 'Group Settings',
    help: 'Per-room mention and tool-policy override. Leave unset to inherit the root setting.',
  },
};
