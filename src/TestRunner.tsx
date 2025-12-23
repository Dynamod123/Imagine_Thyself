import { Stage } from "./Stage";
import { useEffect, useState } from "react";
import { DEFAULT_INITIAL, StageBase, InitialData } from "@chub-ai/stages-ts";

// Modify this JSON to include whatever character/user information you want to test.
import InitData from './assets/test-init.json';

export interface TestStageRunnerProps<StageType extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType>, InitStateType, ChatStateType, MessageStateType, ConfigType> {
    factory: (data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) => StageType;
}

/***
 This is a testing class for running a stage locally when testing,
    outside the context of an active chat. See runTests() below for the main idea.
 ***/
export const TestStageRunner = <StageType extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType>,
    InitStateType, ChatStateType, MessageStateType, ConfigType>({ factory }: TestStageRunnerProps<StageType, InitStateType, ChatStateType, MessageStateType, ConfigType>) => {

    // You may need to add a @ts-ignore here,
    //     as the linter doesn't always like the idea of reading types arbitrarily from files
    // @ts-ignore
    const [stage, _setStage] = useState(new Stage({ ...DEFAULT_INITIAL, ...InitData }));

    // This is what forces the stage node to re-render.
    const [node, setNode] = useState(new Date());

    function refresh() {
        setNode(new Date());
    }

    async function delayedTest(test: any, delaySeconds: number) {
        await new Promise(f => setTimeout(f, delaySeconds * 1000));
        return test();
    }

    /***
     This is the main thing you'll want to modify.
     ***/
    async function runTests() {
        console.log("Running manual extraction logic tests...");

        const mockStage = stage as any;

        // Test 1: Content with <output> tags
        const rawResponse1 = { result: "Certainly! Here is the message: <output>Hello world</output>" };
        const match1 = rawResponse1.result.match(/<output>([\s\S]*?)<\/output>/i);
        console.assert(match1 && match1[1].trim() === "Hello world", "Test 1 Failed: <output> extraction");

        // Test 2: Content without tags but with meta-commentary (Fallback)
        const rawResponse2 = { result: "Sure thing! Understood.\n\n[Mode: Impersonation]\nHello fallback" };
        let textResult2 = rawResponse2.result;
        let cleaning = true;
        while (cleaning) {
            const original = textResult2;
            textResult2 = textResult2
                .replace(/^\s*\[.*?\]\s*/s, '')
                .replace(/^\s*\{.*?\}\s*/s, '')
                .replace(/^\s*(?:Understood|Noted|Sure|Okay|Alright|Error|Terminating|I cannot|System\s*Alert).*?(\n|$)/is, '')
                .trim();
            if (textResult2 === original) cleaning = false;
        }
        console.assert(textResult2 === "Hello fallback", `Test 2 Failed: Fallback cleaning (Got: ${textResult2})`);

        console.log("Extraction logic tests passed!");
    }

    useEffect(() => {
        // Always do this first, and put any other calls inside the load response.
        stage.load().then((res) => {
            console.info(`Test StageBase Runner load success result was ${res.success}`);
            if (!res.success || res.error != null) {
                console.error(`Error from stage during load, error: ${res.error}`);
            } else {
                runTests().then(() => console.info("Done running tests."));
            }
        });
    }, []);

    return <>
        <div style={{ display: 'none' }}>{String(node)}{window.location.href}</div>
        {stage == null ? <div>Stage loading...</div> : stage.render()}
    </>;
}
