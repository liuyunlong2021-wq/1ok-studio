import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ state: {} as any, api: {
    getStylePresets: vi.fn(async () => []), getProject: vi.fn(),
    saveProductionAssetPrompt: vi.fn(async () => ({})), generateAsset: vi.fn(async () => ({})),
    resumeAssetImage: vi.fn(async () => ({ status: "processing" })),
    generateProductionAssetPrompt: vi.fn(), updateAssetDescription: vi.fn(async () => ({})),
} }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("@/store/projectStore", () => ({ IMAGE_MODELS: [], useProjectStore: Object.assign((selector: any) => selector(mocks.state), { getState: () => mocks.state }) }));
vi.mock("@/store/toastStore", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), progress: vi.fn(() => "progress"), dismiss: vi.fn() } }));
vi.mock("@/components/modules/CharacterWorkbench", () => ({ default: (props: any) => <div>
    <h2>{props.asset.name}</h2>{props.toolbar}{props.contextPanel}
    <img alt="当前造型" src={props.asset.full_body_image_url} />
    <p>{props.asset.description}</p>
    {props.asset.production_image_task?.can_resume && <button onClick={() => props.onResumeImageTask(props.asset.production_image_task.task_id)}>继续取回测试图片</button>}
    <button onClick={() => props.onGenerate("full_body", props.asset.full_body_prompt, true, "", 1)}>生成测试图片</button>
</div> }));

import CastWorkbenchModal from "./CastWorkbenchModal";
import { activePolls } from "./CastWorkbenchModal";

describe("production character workbench", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.state.currentProject = {
            id: "project", title: "测试", production_workflow: "engineering_segments_v1", frames: [],
            production_settings: { image_model: "image-model", aspect_ratio: "9:16" },
            characters: [{ id: "c1", name: "莱拉", description: "人物固定资料9527", source: "episode", voice_design: {}, looks: [
                { id: "work", name: "工装", description: "补丁工装", reference_sheet: { image_prompt: "工装完整提示词", selected_image_id: "a", image_variants: [{ id: "a", url: "work.png" }] } },
                { id: "dress", name: "礼服", description: "白色礼服", reference_sheet: { image_prompt: "礼服完整提示词", selected_image_id: "b", image_variants: [{ id: "b", url: "dress.png" }] } },
            ] }], scenes: [], props: [],
        };
        mocks.state.projects = [];
        mocks.state.currentSeries = null;
        mocks.state.generatingTasks = [];
        mocks.state.updateProject = vi.fn();
        mocks.state.addGeneratingTask = vi.fn();
        mocks.state.removeGeneratingTask = vi.fn();
        mocks.api.getProject.mockImplementation(async () => mocks.state.currentProject);
    });

    it("switches appearance and submits the selected look without generating during selection", async () => {
        render(<CastWorkbenchModal isOpen kind="character" entityId="c1" onClose={vi.fn()} />);
        expect(screen.getByAltText("当前造型").getAttribute("src")).toBe("work.png");
        fireEvent.change(screen.getByLabelText("角色造型"), { target: { value: "dress" } });
        await waitFor(() => expect(screen.getByAltText("当前造型").getAttribute("src")).toBe("dress.png"));
        expect(screen.getByText("白色礼服")).toBeTruthy();
        expect(mocks.api.generateAsset).not.toHaveBeenCalled();
        expect(mocks.api.generateProductionAssetPrompt).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText("生成测试图片"));
        await waitFor(() => expect(mocks.api.generateAsset).toHaveBeenCalledOnce());
        expect(mocks.api.generateAsset.mock.calls[0].at(-1)).toBe("dress");
        expect(mocks.api.saveProductionAssetPrompt).toHaveBeenCalledWith("project", "c1", "礼服完整提示词", "dress");
    });

    it("resumes an existing image task without submitting a new generation", async () => {
        mocks.state.currentProject.characters[0].looks[0].production_image_task = {
            task_id: "image-task-1", phase: "download_pending", can_resume: true,
        };
        const timer = vi.spyOn(globalThis, "setInterval").mockReturnValue(1 as any);
        render(<CastWorkbenchModal isOpen kind="character" entityId="c1" onClose={vi.fn()} />);

        fireEvent.click(screen.getByText("继续取回测试图片"));
        await waitFor(() => expect(mocks.api.resumeAssetImage).toHaveBeenCalledWith("project", "image-task-1"));

        expect(mocks.api.generateAsset).not.toHaveBeenCalled();
        activePolls.clear();
        timer.mockRestore();
    });
});
