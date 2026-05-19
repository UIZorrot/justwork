declare module "sortablejs" {
  type SortableEvent = {
    item?: HTMLElement | null;
    to?: HTMLElement | null;
    newIndex?: number | null;
  };

  type SortableOptions = {
    animation?: number;
    group?: string;
    draggable?: string;
    handle?: string;
    ghostClass?: string;
    chosenClass?: string;
    dragClass?: string;
    fallbackOnBody?: boolean;
    swapThreshold?: number;
    onEnd?: (event: SortableEvent) => void;
  };

  class Sortable {
    constructor(element: HTMLElement, options?: SortableOptions);
    destroy(): void;
    static create(element: HTMLElement, options?: SortableOptions): Sortable;
  }

  export default Sortable;
}
