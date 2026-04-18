import { z } from "zod";

export const CreateFileSchema = z.object({
  path: z.string().describe("Path for the main HTML file. Use index.html if unsure."),
  content: z.string().describe("Full HTML for the single-file app."),
});

export const EditFileSchema = z.object({
  path: z.string().describe("Path for the main HTML file."),
  old_text: z.string().describe("Exact text to replace. Must match the file contents."),
  new_text: z.string().describe("Replacement text."),
  count: z.number().int().optional().describe("How many occurrences to replace. Defaults to 1."),
});

export type CreateFileInput = z.infer<typeof CreateFileSchema>;
export type EditFileInput = z.infer<typeof EditFileSchema>;

export interface FileState {
  path: string;
  content: string;
}