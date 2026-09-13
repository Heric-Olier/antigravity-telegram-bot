import { CommandContext, Context } from "grammy";
import { listModels } from "../../antigravity/model-list.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

export async function modelsCommand(ctx: CommandContext<Context>) {
  try {
    const models = await listModels();

    if (models.length === 0) {
      await ctx.reply(t("legacy.models.empty"));
      return;
    }

    let message = t("legacy.models.header");

    for (const model of models) {
      message += `  - ${model.id} (${model.label})\n`;
    }

    await ctx.reply(message);
  } catch (error) {
    logger.error("[ModelsCommand] Error listing models:", error);
    await ctx.reply(t("legacy.models.error"));
  }
}
