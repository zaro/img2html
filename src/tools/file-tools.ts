import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { dirname } from "path";

export interface FileState {
  path: string;
  content: string;
}

export function createCreateFileTool(fileState: { current: FileState | null }) {
  return tool(
    async ({ path: filePath, content }: { path: string; content: string }) => {
      const resolvedPath = path.resolve(filePath);
      const dir = dirname(resolvedPath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(resolvedPath, content, "utf-8");

      fileState.current = { path: resolvedPath, content };

      const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;

      return JSON.stringify({
        success: true,
        path: resolvedPath,
        contentLength: content.length,
        preview,
      });
    },
    {
      name: "create_file",
      description: "Create the main HTML file for the app. Use exactly once to write the full HTML.",
      schema: z.object({
        path: z.string().describe("Path for the main HTML file. Use index.html if unsure."),
        content: z.string().describe("Full HTML for the single-file app."),
      }),
    }
  );
}

export function createEditFileTool(fileState: { current: FileState | null }) {
  return tool(
    async ({ path: filePath, old_text, new_text, count }: { path: string; old_text: string; new_text: string; count: number | null }) => {
      if (!fileState.current) {
        return JSON.stringify({
          success: false,
          error: "No file has been created yet. Use create_file first.",
        });
      }

      const resolvedPath = path.resolve(filePath);
      let content = fileState.current.content;

      if (!content.includes(old_text)) {
        return JSON.stringify({
          success: false,
          error: `Could not find old_text in the file. Make sure the exact string exists.`,
          old_text_preview: old_text.slice(0, 100),
        });
      }

      const replaceCount = count ?? 1;
      if (replaceCount === -1) {
        content = content.split(old_text).join(new_text);
      } else {
        let occurrences = 0;
        content = content.split(old_text).reduce((acc, part, idx, arr) => {
          if (idx < arr.length - 1 && occurrences < replaceCount) {
            occurrences++;
            return acc + part + new_text;
          }
          return acc + part;
        }, "");
      }

      fs.writeFileSync(resolvedPath, content, "utf-8");
      fileState.current = { path: resolvedPath, content };

      return JSON.stringify({
        success: true,
        path: resolvedPath,
        edit_summary: `Replaced ${count ?? 1} occurrence(s) of text (${old_text.length} chars) with (${new_text.length} chars)`,
      });
    },
    {
      name: "edit_file",
      description: "Edit the main HTML file using exact string replacements. Do not regenerate the entire file.",
      schema: z.object({
        path: z.string().describe("Path for the main HTML file."),
        old_text: z.string().describe("Exact text to replace. Must match the file contents."),
        new_text: z.string().describe("Replacement text."),
        count: z.number().int().nullable().describe("How many occurrences to replace. Defaults to 1."),
      }),
    }
  );
}