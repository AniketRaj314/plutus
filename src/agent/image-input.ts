import type { ResponseInputItem } from "openai/resources/responses/responses";

export interface AgentImageInput {
  data_url: string;
}

export function buildUserInputItem(
  text: string,
  images: AgentImageInput[] = []
): ResponseInputItem {
  if (images.length === 0) return { role: "user", content: text };

  return {
    role: "user",
    content: [
      { type: "input_text", text },
      ...images.map((image) => ({
        type: "input_image" as const,
        image_url: image.data_url,
        detail: "high" as const,
      })),
    ],
  };
}

export function persistedImageMessage(text: string, imageCount: number): string {
  if (imageCount === 0) return text;
  const label = imageCount === 1 ? "image" : "images";
  return `${text}\n[${imageCount} ${label} attached for this turn; image content was not retained]`;
}
