export const THREAD_POST_ROLES = ["unspecified","answer","context","counterpoint","question","correction","source"] as const;
export type ThreadPostRole = typeof THREAD_POST_ROLES[number];
export const THREAD_WORKFLOW_STATES = ["open","answered","resolved","verification","update_needed","closed"] as const;
export type ThreadWorkflowState = typeof THREAD_WORKFLOW_STATES[number];
export const THREAD_VOTE_REASONS = ["incorrect","unsupported","off_topic","unclear"] as const;
export type ThreadVoteReason = typeof THREAD_VOTE_REASONS[number];
export type ThreadSource = { url:string; label:string; kind:"primary"|"news"|"personal"|"other" };
export const ROLE_LABELS:Record<ThreadPostRole,string>={unspecified:"通常",answer:"回答",context:"補足",counterpoint:"反対意見",question:"質問",correction:"訂正",source:"出典"};
export const WORKFLOW_LABELS:Record<ThreadWorkflowState,string>={open:"回答募集中",answered:"回答あり",resolved:"解決済み",verification:"検証中",update_needed:"情報更新待ち",closed:"終了"};
export function classifySummarySection(role:ThreadPostRole, score:number, down:number){
  if(role==="counterpoint"||down>0&&score<=2)return "different_views" as const;
  if(role==="correction"||role==="source")return "evidence" as const;
  if(role==="answer")return "answers" as const;
  return "key_points" as const;
}
export const SUMMARY_SECTION_LABELS={key_points:"要点",answers:"有力な回答",different_views:"異なる見方",evidence:"訂正・出典"}as const;
