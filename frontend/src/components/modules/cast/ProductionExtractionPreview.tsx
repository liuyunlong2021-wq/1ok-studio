"use client";

export default function ProductionExtractionPreview({ preview, onChange }: { preview: any; onChange: (value: any) => void }) {
    return <div className="mt-3 space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
            {([['characters', '角色'], ['scenes', '场景'], ['props', '道具']] as const).map(([kind, label]) => <section key={kind} className="rounded-lg border border-glass-border bg-glass p-3">
                <h3 className="mb-2 text-xs font-medium">{label} · {preview[kind]?.length || 0}{kind === "characters" && ` 人 / ${(preview.characters || []).reduce((sum: number, item: any) => sum + (item.looks?.length || 0), 0)} 套造型`}</h3>
                <div className="space-y-2 text-xs text-text-secondary">{(preview[kind] || []).map((item: any) => <details key={item.id} className="rounded border border-glass-border p-2">
                    <summary className="cursor-pointer">{item.name}{item.match_ambiguous ? " · 同名有歧义" : item.match_id ? " · 将复用" : " · 新增"}</summary>
                    <p className="mt-2 whitespace-pre-wrap leading-5">{item.description}</p>
                    {(item.looks || []).map((look: any) => <div key={look.id} className="mt-2 border-t border-glass-border pt-2"><p className="font-medium">{look.name}</p><p className="mt-1 whitespace-pre-wrap leading-5">{look.description || "工程剧本未交代具体服装"}</p></div>)}
                    {(item.extraction_unknowns || []).map((value: string) => <p key={value} className="mt-2 text-text-muted">未交代／待确定：{value}</p>)}
                    {(item.extraction_evidence || []).map((value: any, index: number) => <p key={index} className="mt-2 text-text-muted">{value.shot_number ? `镜头${value.shot_number}` : "总说明"}：{value.quote}</p>)}
                </details>)}</div>
            </section>)}
        </div>
        {preview.shot_bindings?.length > 0 && <details className="rounded-lg border border-glass-border p-3 text-xs">
            <summary className="cursor-pointer">镜头造型绑定 · 可直接调整，无需重新提取</summary>
            <div className="mt-3 grid max-h-56 gap-2 overflow-auto sm:grid-cols-2">{preview.shot_bindings.map((row: any, rowIndex: number) => row.characters.map((ref: any, index: number) => {
                const character = preview.characters.find((item: any) => item.id === ref.character_id);
                if (!character?.looks?.length) return null;
                return <label key={`${row.shot_number}:${ref.character_id}`} className="flex items-center justify-between gap-2"><span>镜头{row.shot_number} · {character.name}</span><select aria-label={`镜头${row.shot_number} ${character.name}造型`} value={ref.look_id || ""} onChange={(event) => onChange({ ...preview, shot_bindings: preview.shot_bindings.map((value: any, i: number) => i !== rowIndex ? value : { ...value, characters: value.characters.map((item: any, j: number) => j !== index ? item : { ...item, look_id: event.target.value || null }) }) })} className="max-w-48 rounded border border-glass-border bg-input-bg p-1.5"><option value="">待指定造型</option>{character.looks.map((look: any) => <option key={look.id} value={look.id}>{look.name}</option>)}</select></label>;
            }))}</div>
        </details>}
    </div>;
}
