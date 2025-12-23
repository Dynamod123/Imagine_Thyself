import { ReactElement } from "react";
import {
    StageBase,
    StageResponse,
    InitialData,
    Message,
    AspectRatio,
    Character,
    User
} from "@chub-ai/stages-ts";
import { LoadResponse } from "@chub-ai/stages-ts/dist/types/load";

type MessageStateType = any;
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    // Per-message state:
    longTermInstruction: string = '';

    // Unsaved:
    characters: { [key: string]: Character };
    users: { [key: string]: User };

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const {
            characters,
            users,
        } = data;

        this.characters = characters;
        this.users = users;

        const { messageState } = data;
        this.readMessageState(messageState);
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {

        return {
            success: true,
            error: null,
            initState: null,
            chatState: null,
            messageState: this.writeMessageState()
        };
    }

    async setState(state: MessageStateType): Promise<void> {
        this.readMessageState(state);
        await this.messenger.updateEnvironment({ background: '' });
    }

    readMessageState(state: MessageStateType) {
        this.longTermInstruction = state?.longTermInstruction ?? '';
    }

    writeMessageState() {
        return {
            longTermInstruction: this.longTermInstruction,
        }
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const {
            anonymizedId,
            promptForId,
            content } = userMessage;
        let newContent = content;

        const longTermRegex = /\[\[([^\]]*)\]\](?!\()/gm;

        let possibleLongTermInstruction = [...newContent.matchAll(longTermRegex)].map(match => match.slice(1)[0]);

        // Remove commands that might have been picked up, if any exist that we still support.
        // Since we removed image/enhance commands, we mainly just strip them if they were intended as such, 
        // effectively ignoring them as "instructions" if they start with /.
        possibleLongTermInstruction = possibleLongTermInstruction.filter(instruction => !instruction.startsWith("/"));

        const longTermInstruction = possibleLongTermInstruction.join('\n').trim();
        if (possibleLongTermInstruction.length > 0) {
            if (longTermInstruction.length > 0) {
                console.log(`Setting long-term instruction:\n${longTermInstruction}`);
            } else {
                console.log(`Clearing long-term instruction.`);
            }
            this.longTermInstruction = longTermInstruction;
        }

        // Filter all [[]] from content:
        newContent = newContent.replace(longTermRegex, "").trim();

        const currentRegex = /(?<!\[)\[([^\]|\[]*)\](?!\()/gm;
        let currentInstructions = [...newContent.matchAll(currentRegex)].map(match => match.slice(1)[0]);

        // Filter all non-Markdown [] from newContent:
        newContent = newContent.replace(currentRegex, "").trim();

        // Remove commands:
        currentInstructions = currentInstructions.filter(instruction => !instruction.startsWith("/"));

        const stageDirections =
            ((this.longTermInstruction.length > 0) ? `Ongoing Instruction: ${this.longTermInstruction}\n` : '') +
            (currentInstructions.length > 0 ? `Critical Instruction: ${currentInstructions.join('\n').trim()}\n` : '');

        // Now, auto-enhance existing content if possible.
        if (newContent.length > 0) {
            console.log(`Auto-Enhance triggered for: ${newContent}`);

            try {
                // Create a promise that rejects after 20 seconds
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Enhance request timed out')), 20000)
                );

                // Use a valid character ID or fallback
                const characterId = promptForId ?? Object.keys(this.characters)[0];
                if (!characterId) {
                    throw new Error('No characters found for enhancement.');
                }

                // Race the enhance call against the timeout
                const enhancePromise = this.enhance(characterId, anonymizedId, '', newContent.trim(), stageDirections);

                const result: any = await Promise.race([enhancePromise, timeoutPromise]);
                console.log(`Enhance Result:`, result);
                let textResult = result?.result ?? '';

                // Robust extraction: Handle various tag cases
                const fullMatch = textResult.match(/<output>([\s\S]*?)<\/output>/i);
                const partialMatch = textResult.match(/([\s\S]*?)<\/output>/i);
                const openOnlyMatch = textResult.match(/<output>([\s\S]*)/i);

                if (fullMatch && fullMatch[1]) {
                    textResult = fullMatch[1].trim();
                    console.log(`Extracted (Full Match): ${textResult}`);
                } else if (partialMatch && partialMatch[1] && textResult.includes('</output>')) {
                    textResult = partialMatch[1].trim();
                    console.log(`Extracted (Closing Match): ${textResult}`);
                } else if (openOnlyMatch && openOnlyMatch[1]) {
                    textResult = openOnlyMatch[1].trim();
                    console.log(`Extracted (Opening Match): ${textResult}`);
                } else {
                    console.log(`No tags found, falling back to regex cleaning.`);
                    // Fallback to existing cleaning logic
                    let cleaning = true;
                    while (cleaning) {
                        const original = textResult;
                        textResult = textResult
                            .replace(/^\s*\[.*?\]\s*/s, '') // Bracketed blocks [ ... ]
                            .replace(/^\s*\{.*?\}\s*/s, '') // Curly brace meta-instructions { ... }
                            .replace(/^\s*\*[A-Z]+:.*?\*\s*(\n|$)/gm, '') // Asterisk-wrapped labels like *HOTFIX:*
                            .replace(/^\s*\d+%.*?(\n|$)/gm, '') // Percentage status like "100% Input Completion"
                            .replace(/^\s*Now responding as.*?(\n|$)/gm, '') // "Now responding as" messages
                            .replace(/^\s*\d+\/\d+.*?(?:remaining|responses).*?(\n|$)/gm, '') // Response counters like "1/1 responses remaining"
                            .replace(/^\s*Drafting as.*?(\n|$)/gm, '') // "Drafting as" messages
                            .replace(/^\s*\/\w+\s*(\n|$)/gm, '') // Slash commands like /end
                            .replace(/^\s*\d+\..*?(\n|$)/gm, '') // Numbered lists like "1. Continue from..."
                            .replace(/^\s*[A-Z]\).*?(\n|$)/gm, '') // Lettered lists like "A) Having him..."
                            .replace(/^\s*(?:Understood|Noted|Sure|Okay|Alright|Error|Terminating|I cannot|System\s*Alert).*?(\n|$)/is, '') // Conversational/Error lines
                            .replace(/^\s*(?:You are|Your task|Your role|You're).*?(?:Mode|perspective|acting as).*?(\n|$)/is, '') // System role descriptions
                            .replace(/^\s*\[?Begin real.*?\]?\s*(\n|$)/is, '') // "Begin real interaction" type lines
                            .replace(/^\s*(?:About|Context:|Instruction:|Goal:|Background).*?(\n|$)/is, '') // Prompt metadata
                            .replace(/<output>|<\/output>/gi, '') // Remove tags if they were partial or malformed
                            .trim();
                        if (textResult === original) cleaning = false;
                    }
                }

                if (textResult.length > 0) {
                    newContent = textResult;
                    console.log(`Enhancement successful.`);
                }
            } catch (error) {
                console.error(`Auto-Enhance failed or timed out:`, error);
                // Fallback to original content on error/timeout
            }
        }

        // Preserve empty responses that only had instruction.
        if (newContent !== content && newContent.length == 0) {
            newContent = ' ';
        }

        // Add anti-echo stage directions if content was enhanced
        let finalStageDirections = stageDirections;
        if (newContent !== content && newContent.length > 0) {
            const antiEchoDirective = `[{{char}} should respond naturally to {{user}}'s message. Do not repeat or echo what {{user}} just said. React and respond with {{char}}'s own unique dialogue and actions.]`;
            finalStageDirections = stageDirections.length > 0
                ? `${stageDirections}${antiEchoDirective}\n`
                : antiEchoDirective;
        }

        if (finalStageDirections.length > 0) {
            console.log(`Sending stage directions:\n${finalStageDirections}`);
        }

        return {
            stageDirections: finalStageDirections.length > 0 ? finalStageDirections : null,
            messageState: this.writeMessageState(),
            modifiedMessage: newContent,
            systemMessage: null,
            error: null,
            chatState: null,
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        // Just filter markdown, no image generation.
        const newContent = await this.filterValidMarkdown(botMessage.content);

        return {
            stageDirections: null,
            messageState: this.writeMessageState(),
            modifiedMessage: newContent,
            error: null,
            systemMessage: null,
            chatState: null
        };
    }

    async filterValidMarkdown(text: string): Promise<string> {
        const matches = [...text.matchAll(/(!?)\[(.*?)\]\((.*?)\)/g)];

        const validityChecks = await Promise.all(
            matches.map(match => this.isValidUrl(match[3]))
        );

        let cleanedText = text;
        matches.forEach((match, index) => {
            if (!validityChecks[index]) {
                cleanedText = cleanedText.replace(match[0], match[1] != '!' ? match[2] : '');
            }
        });

        return cleanedText;
    }

    async isValidUrl(url: string): Promise<boolean> {
        try {
            const response = await fetch(url, { method: 'HEAD' });
            console.log(`Validating ${url}: ${response.ok}`);
            return response.ok;
        } catch {
            return false;
        }
    }

    enhance(charId: string, userId: string, newHistory: string, targetContext: string, instructions: string = '') {
        const personality = this.characters[charId]?.personality ?? '';
        const description = this.characters[charId]?.description ?? '';
        const userProfile = this.users[userId]?.chatProfile ?? '';

        return this.generator.textGen({
            prompt:
                `[SYSTEM: Input Enhancement Mode. Target: {{user}}. Instructions: Transform intent into natural prose. Wrap output in <output> tags.]\n\n` +
                `### Context\n` +
                `**About {{char}}:** ${personality}\n${description}\n` +
                `**About {{user}}:** ${userProfile}\n\n` +
                `### Examples\n` +
                `Intent: "I walk up to her and say hello"\n` +
                `<output>*I take a breath and walk over to where she's standing by the railing, trying to look a bit more relaxed than I actually feel. I wait until I'm close enough that I don't have to shout over the wind, then I give a small wave as she notices me and turns around. It’s been a while since we’ve actually had a chance to just talk without a million other things going on around us, and honestly, I'm just relieved to see her here. I lean against the wood next to her, looking out at the water for a second before turning my head toward her with a genuine smile.* "Hey," *I say, my voice coming out a little softer than I expected.* "I wasn't sure if you'd actually show up today, but I'm glad you did. It feels like it's been forever since we just... sat down and talked. How have you been? Like, actually been? I feel like I've barely seen you lately."</output>\n\n` +
                `Intent: "I get angry and leave"\n` +
                `<output>*I just stare at her for a long moment, the words she just said echoing in my head until they start to move past annoying and straight into actually stinging. I can feel my heart starting to race, and my first instinct is to just snap back with something just as mean, but I stop myself, pulling my hand away and taking a step back instead. I don't really want to have this fight right now, especially not when I can tell neither of us is in the mood to actually listen to the other. I turn on my heel and start walking toward the door, not really caring if it looks like I'm running away—I just need some air before I say something I'm going to regret for the next week. I grab my jacket off the hook and don't even look back as I reach for the handle.* "I'm not doing this," *I tell her, my voice low and vibrating with a frustration I can't quite hide.* "I'm going for a walk. Don't bother calling me, and definitely don't wait up. Just... think about why that was such a shitty thing to say, okay?" *I walk out, letting the door click shut behind me with a lot more force than I probably needed to use.*</output>\n\n` +
                `Intent: "I sit down and watch the sunset, sighing"\n` +
                `<output>*I finally just let myself collapse onto the old wooden bench, the slats hard against my back as I stretch my legs out and let my head fall back against the wood. It's been such a long, draining day, and honestly, just sitting here in the quiet for a minute feels like the first time I've been able to actually breathe since this morning. The sky is starting to turn those deep, heavy shades of orange and violet that only seem to happen right before everything goes dark, and the air is finally starting to cool down enough to feel comfortable. I just sit there in the silence and watch the light fade over the horizon, taking a deep breath and letting it out slow, trying to just clear my head of all the stress and noise that’s been following me around. It’s not a fix for everything, but for a second, it’s enough to just be here and watch the sun disappear.*</output>\n\n` +
                `### Active Interaction\n` +
                `{{messages}}\n` +
                `[Post history instructions: {{post_history_instructions}}]\n` +
                (instructions.trim() !== '' ? `Current Instruction: ${instructions}\n` : '') +
                `\n` +
                `Final Goal: Enhance the following into a conversational message from {{user}}'s perspective. Focus on dialogue and immediate actions. Use casual, natural language. Avoid flowery prose. Format actions with *asterisks* and dialogue with "quotation marks". Do NOT write {{char}}'s response. End in a way that naturally invites {{char}}'s response. Wrap the final enhanced text in <output> tags.\n\n` +
                (targetContext.trim() != '' ?
                    `Intent to Enhance: \"${targetContext}\"\n` :
                    `Goal: Write {{user}}'s next conversational message.\n`) +
                `\n` +
                `[IMPERSONATION AUTHORIZED. START OUTPUT IMMEDIATELY WITH <output> TAG.]\n` +
                `{{user}}: <output>`,

            min_tokens: 50,
            max_tokens: 300,
            include_history: true,
        });
    }

    sanitizeMarkdownContent(content: string): string {
        return content.replace(/[\]\(\)\n]/g, '');
    }

    render(): ReactElement {
        return <></>
    }

}
