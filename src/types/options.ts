export interface Img2HtmlOptions {
  imagePath: string;
  stack: "html_css" | "tailwind";
  modelString: string;
  additionalPrompt?: string;
  maxWidth?: number;
  maxHeight?: number;
}
