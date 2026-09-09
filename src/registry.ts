import type { ChannelConnector, ChannelType } from "./types";
import { messengerConnector, instagramConnector, whatsappConnector } from "./connectors/meta";
import { lineConnector } from "./connectors/line";
import { emailConnector } from "./connectors/email";

export const connectors: Partial<Record<ChannelType, ChannelConnector>> = {
  messenger: messengerConnector,
  instagram: instagramConnector,
  whatsapp: whatsappConnector,
  line: lineConnector,
  email: emailConnector,
};

export function connectorFor(channelType: ChannelType): ChannelConnector {
  const c = connectors[channelType];
  if (!c) throw new Error(`no connector for channel "${channelType}"`);
  return c;
}
