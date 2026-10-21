/**
 * jQuery UI's sortable marks each item's handle with `ui-sortable-handle` through one `_addClass`
 * call per item. Every call merges the element into the widget's class lookup and re-sorts that
 * whole collection by document position, so a list of n items costs O(n² log n). The prompt
 * manager re-creates its sortable on every render, which took seconds with a few hundred prompts.
 *
 * Passing all handles to a single `_addClass` call produces the same classes, the same lookup
 * contents and the same `remove` tracking, with one sort instead of n.
 */

/**
 * @param {JQueryStatic} $ jQuery with jQuery UI loaded
 * @returns {boolean} Whether the patch is installed
 */
export function installBatchedSortableHandles($) {
    const prototype = $?.ui?.sortable?.prototype;
    if (!prototype || prototype._setHandleClassName.batchedHandles) {
        return Boolean(prototype);
    }

    function setHandleClassName() {
        this._removeClass(this.element.find('.ui-sortable-handle'), 'ui-sortable-handle');
        // A Set keeps each element once, as the per-item calls did by finding it already tracked.
        const handles = new Set();
        for (const item of this.items) {
            const handle = item.instance.options.handle ? item.item.find(item.instance.options.handle) : item.item;
            handle.each((_, element) => handles.add(element));
        }
        this._addClass($([...handles]), 'ui-sortable-handle');
    }
    setHandleClassName.batchedHandles = true;
    prototype._setHandleClassName = setHandleClassName;
    return true;
}
