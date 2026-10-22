import { z } from "zod";
import { citationSchema } from "./policy-core.ts";

export type ChatMessage = { role: "user" | "assistant"; content: string };
export const chatAnswerSchema = z.object({
  Answer: z.string().trim().min(1).max(24000),
  Citation: z.array(citationSchema).max(20),
}).strict();
export type ChatReply = {
  text: string;
  citations: (z.infer<typeof citationSchema> & { href: string | null })[];
};
export type PolicyChatState = {
  contextId: string;
  messages: ChatMessage[];
  replies: ChatReply[];
  busy: boolean;
};
