/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { TrackedRangeStickiness } from 'vs/editor/common/model';
import { FoldingRegions } from 'vs/editor/contrib/folding/foldingRanges';
import { IFoldingRangeData, sanitizeRanges } from 'vs/editor/contrib/folding/syntaxRangeProvider';
import { ICellRange } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { CellViewModel, NotebookViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/notebookViewModel';
import { CellKind } from 'vs/workbench/contrib/notebook/common/notebookCommon';

export class FoldingModel extends Disposable {
	private _viewModel: NotebookViewModel | null = null;
	private _viewModelStore = new DisposableStore();
	private _regions: FoldingRegions;
	get regions() {
		return this._regions;
	}

	private _onDidFoldingRegionChanges = new Emitter<void>();
	onDidFoldingRegionChanged: Event<void> = this._onDidFoldingRegionChanges.event;

	private _foldingRangeDecorationIds: string[] = [];

	constructor(
		// private readonly _notebookEditor: INotebookEditor
	) {
		super();
		this._regions = new FoldingRegions(new Uint32Array(0), new Uint32Array(0));
	}

	detachViewModel() {
		this._viewModelStore.clear();
		this._viewModel = null;
	}

	attachViewModel(model: NotebookViewModel) {
		this._viewModel = model;

		this._viewModelStore.add(this._viewModel.onDidChangeViewCells(() => {
			this.recompute();
		}));

		this.recompute();
	}

	public setCollapsed(index: number, newState: boolean) {
		this._regions.setCollapsed(index, newState);
	}

	recompute() {
		const cells = this._viewModel!.viewCells;
		let stack: { index: number, level: number, endIndex: number }[] = [];

		for (let i = 0; i < cells.length; i++) {
			const cell = cells[i];

			if (cell.cellKind === CellKind.Code) {
				continue;
			}

			const content = cell.getText();

			const matches = content.match(/^[ \t]*(\#+)/gm);

			let min = 7;
			if (matches && matches.length) {
				for (let j = 0; j < matches.length; j++) {
					min = Math.min(min, matches[j].length);
				}
			}

			if (min < 7) {
				// header 1 to 6
				stack.push({ index: i, level: min, endIndex: 0 });
			}
		}

		// calcualte folding ranges
		const rawFoldingRanges: IFoldingRangeData[] = stack.map((entry, startIndex) => {
			let end: number | undefined = undefined;
			for (let i = startIndex + 1; i < stack.length; ++i) {
				if (stack[i].level <= entry.level) {
					end = stack[i].index - 1;
					break;
				}
			}

			const endIndex = end !== undefined ? end : cells.length - 1;

			// one based
			return {
				start: entry.index + 1,
				end: endIndex + 1,
				rank: 1
			};
		});

		const newRegions = sanitizeRanges(rawFoldingRanges, 5000);

		// restore collased state
		let i = 0;
		let nextCollapsed = () => {
			while (i < this._regions.length) {
				let isCollapsed = this._regions.isCollapsed(i);
				i++;
				if (isCollapsed) {
					return i - 1;
				}
			}
			return -1;
		};

		let k = 0;
		let collapsedIndex = nextCollapsed();

		while (collapsedIndex !== -1 && k < newRegions.length) {
			// get the latest range
			let decRange = this._viewModel!.getTrackedRange(this._foldingRangeDecorationIds[collapsedIndex]);
			if (decRange) {
				let collasedStartIndex = decRange.start;

				while (k < newRegions.length) {
					let startIndex = newRegions.getStartLineNumber(k) - 1;
					if (collasedStartIndex >= startIndex) {
						newRegions.setCollapsed(k, collasedStartIndex === startIndex);
						k++;
					} else {
						break;
					}
				}
			}
			collapsedIndex = nextCollapsed();
		}

		while (k < newRegions.length) {
			newRegions.setCollapsed(k, false);
			k++;
		}

		const cellRanges: ICellRange[] = [];
		for (let i = 0; i < newRegions.length; i++) {
			const region = newRegions.toRegion(i);
			cellRanges.push({ start: region.startLineNumber - 1, length: region.endLineNumber - region.startLineNumber + 1 });
		}

		// remove old tracked ranges and add new ones
		// TODO@rebornix, implement delta
		this._foldingRangeDecorationIds.forEach(id => this._viewModel!.setTrackedRange(id, null, TrackedRangeStickiness.GrowsOnlyWhenTypingAfter));
		this._foldingRangeDecorationIds = cellRanges.map(region => this._viewModel!.setTrackedRange(null, region, TrackedRangeStickiness.GrowsOnlyWhenTypingAfter)).filter(str => str !== null) as string[];

		this._regions = newRegions;
		this._onDidFoldingRegionChanges.fire();
	}
}

export enum CellFoldingState {
	None,
	Expanded,
	Collapsed
}

export interface FoldingRegionDelegate {
	onDidFoldingRegionChanged: Event<void>;
	getFoldingStartIndex(cell: CellViewModel): number;
	getFoldingState(cell: CellViewModel): CellFoldingState;
}
