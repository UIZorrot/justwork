declare module "diff-match-patch" {
  export default class DiffMatchPatch {
    Diff_Timeout: number;
    diff_main(text1: string, text2: string): Array<[number, string]>;
    diff_cleanupSemantic(diffs: Array<[number, string]>): void;
    patch_make(text1: string, text2: string): unknown[];
    patch_apply(patches: unknown[], text: string): [string, boolean[]];
  }
}
