import assert from 'node:assert/strict';
import { formatWorkTree } from './lib/work-tree-view.mjs';
const input = {items:[{key:'RPL-112',title:'목표'},{key:'RPL-118',title:'Story'},{key:'RPL-113',title:'기능'}],relations:[{from:'RPL-112',to:'RPL-118',type:'parent'},{from:'RPL-112',to:'RPL-113',type:'parent'},{from:'RPL-118',to:'RPL-113',type:'relates'}]};
const out = formatWorkTree(input);
assert.match(out, /RPL-113 \| relates \| RPL-118/);
assert.doesNotMatch(out, /RPL-118 \| parent \| RPL-113/);
assert.match(out, /UNKNOWN/);
assert.throws(() => formatWorkTree({...input,relations:[{from:'RPL-118',to:'RPL-999',type:'parent'}]}));
assert.throws(() => formatWorkTree({...input,items:[input.items[0],input.items[0]]}));
assert.throws(() => formatWorkTree({...input,relations:[{from:'RPL-118',to:'RPL-113',type:'invented'}]}));
assert.match(formatWorkTree({items:[{key:'RPL-1',title:'<script>|x'}],relations:[]}), /&lt;script&gt;\\\|x/);
const drift = formatWorkTree({items:[{key:'RPL-1',title:' '},{key:'RPL-2'},{key:'RPL-3'}],relations:[
  {from:'RPL-1',to:'RPL-2',type:'parent'}, {from:'RPL-3',to:'RPL-2',type:'parent'},
  {from:'RPL-2',to:'RPL-1',type:'parent'}, {from:'RPL-1',to:'RPL-3',type:'relates',source_ref:'source1'},
  {from:'RPL-3',to:'RPL-1',type:'relates',source_ref:'source2'}, {from:'RPL-1',to:'RPL-2',type:'blocks'}]});
assert.match(drift, /DRIFT: RPL-2/);
assert.match(drift, /DRIFT: Parent/);
assert.equal((drift.match(/\| relates \|/g) ?? []).length, 1);
assert.match(drift, /source1.*source2/);
assert.match(drift, /RPL-1 \| blocks \| RPL-2/);
assert.match(drift, /RPL-1 \| UNKNOWN \|/);
assert.throws(() => formatWorkTree({items:[{key:`RPL-${'1'.repeat(1100)}`}],relations:[]}));
console.log('work-tree relation separation, unknowns and validation PASS');
