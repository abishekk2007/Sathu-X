import { getGeminiClient } from "@/lib/gemini";

async function main() {
  const client = getGeminiClient();
  if (!client) {
    console.log("PROBE: GEMINI_API_KEY missing");
    process.exit(1);
  }
  try {
    const pager = await client.models.list();
    const models: string[] = [];
    for await (const model of pager) {
      models.push(model.name ?? "");
    }
    const imageModels = models.filter((name) =>
      /imagen|image|gemini.*image/i.test(name)
    );
    console.log("TOTAL_MODELS", models.length);
    console.log("IMAGE_MODELS");
    for (const name of imageModels) console.log(" ", name);
  } catch (error) {
    console.error(
      "PROBE FAILED:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

void main();