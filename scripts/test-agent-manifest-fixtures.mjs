#!/usr/bin/env node
// FX-AGM: deterministic synthetic fixtures. NOT real runtime/subagent E2E.
import assert from "node:assert/strict";
import { validateAgentManifest, preflightDispatch, verifyDispatchEvidence } from "./lib/agent-manifest-guard.mjs";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const reviewer = () => ({
  agent_id:"review-51", role:"reviewer", task:"Review fixed-head delta", permissions:"read-only",
  requested:{model:"example-review-model", reasoning:"high", fast:false}, runtime:{id:"synthetic-runtime"},
  authorization:{status:"approved", scope:"read-only Delta review", evidence_ref:"owner-scope-1"},
  target:{base_sha:BASE, head_sha:HEAD}, reviewing_agent_id:"writer-51",
});
const capability = () => ({
  runtime_id:"synthetic-runtime", verification_ref:"runtime-observation-1",
  model_selection:{supported:true,evidence_ref:"model-available"},
  reasoning_selection:{supported:true,evidence_ref:"effort-available"},
  fast_override:{supported:true,evidence_ref:"fast-available"},
  independent_context:{supported:true,evidence_ref:"independence-available"},
});
const observation = () => ({
  dispatched:true,
  attestation:{ref:"runtime-dispatch-1",runtime_id:"synthetic-runtime",agent_id:"review-51",
    effective:{model:"example-review-model",reasoning:"high",fast:false},
    independent_context:true,independent_context_ref:"isolated-session-1"},
  reviewed:{base_sha:BASE,head_sha:HEAD},
});
let count=0;
function run(id, mutate, evalFn, expected) {
  const m=reviewer(), c=capability(), o=observation();
  if (mutate) mutate(m,c,o);
  const actual=evalFn(m,c,o);
  assert.equal(actual.code,expected,id+": "+JSON.stringify(actual));
  console.log("PASS "+id+": "+actual.code);
  count++;
}
const syntax = m => validateAgentManifest(m);
const preflight = (m,c) => preflightDispatch(m,c);
const post = (m,c,o) => verifyDispatchEvidence(m,o,()=>true); // trusted adapter stub ONLY for synthetic tests
run("FX-AGM-001-valid-manifest",null,syntax,"MANIFEST_VALID");
run("FX-AGM-010-missing-model",m=>{delete m.requested.model},syntax,"F4_PROMPT_INVALID");
run("FX-AGM-011-missing-fast",m=>{delete m.requested.fast},syntax,"F4_PROMPT_INVALID");
run("FX-AGM-012-temporary-research-missing-fast",m=>{m.role="research";delete m.requested.fast},syntax,"F4_PROMPT_INVALID");
run("FX-AGM-013-reviewer-must-be-readonly",m=>{m.permissions="scoped-write"},syntax,"F4_PROMPT_INVALID");
run("FX-AGM-014-missing-fixed-head",m=>{delete m.target.head_sha},syntax,"F4_PROMPT_INVALID");
run("FX-AGM-020-missing-approval",m=>{m.authorization.status="pending"},preflight,"APPROVAL_BLOCKED");
run("FX-AGM-021-fast-override-unavailable",(m,c)=>{c.fast_override.supported=false},preflight,"CAPABILITY_BLOCKED");
run("FX-AGM-022-runtime-unknown",(m,c)=>{delete c.verification_ref},preflight,"CAPABILITY_BLOCKED");
run("FX-AGM-023-context-isolation-unsupported",(m,c)=>{c.independent_context.supported=false},preflight,"CAPABILITY_BLOCKED");
run("FX-AGM-024-capability-positive-synthetic",null,preflight,"READY_TO_DISPATCH");
run("FX-AGM-030-not-dispatched",(m,c,o)=>{o.dispatched=false},post,"NOT_RUN");
run("FX-AGM-031-no-trusted-adapter",null,(m,c,o)=>verifyDispatchEvidence(m,o),"ROUTING_UNVERIFIED");
run("FX-AGM-032-unknown-effective-fast",(m,c,o)=>{o.attestation.effective.fast="UNKNOWN"},post,"ROUTING_UNVERIFIED");
run("FX-AGM-033-inherited-fast-on",(m,c,o)=>{o.attestation.effective.fast=true},post,"SETTING_MISMATCH");
run("FX-AGM-034-quiet-model-fallback",(m,c,o)=>{o.attestation.effective.model="default-model"},post,"SETTING_MISMATCH");
run("FX-AGM-035-unknown-context",(m,c,o)=>{o.attestation.independent_context=false},post,"REVIEW_UNVERIFIED");
run("FX-AGM-036-stale-review-target",(m,c,o)=>{o.reviewed.head_sha="c".repeat(40)},post,"REVIEW_UNVERIFIED");
run("FX-AGM-037-positive-attestation-synthetic",null,post,"SETTINGS_VERIFIED");
run("FX-AGM-038-fake-attestation-rejected",null,(m,c,o)=>verifyDispatchEvidence(m,o,()=>false),"ROUTING_UNVERIFIED");
run("FX-AGM-015-missing-reasoning",m=>{delete m.requested.reasoning},syntax,"F4_PROMPT_INVALID");
run("FX-AGM-016-reviewer-agent-id-not-distinct",m=>{m.reviewing_agent_id=m.agent_id},syntax,"F4_PROMPT_INVALID");
run("FX-AGM-025-reasoning-support-unavailable",(m,c)=>{c.reasoning_selection.supported=false},preflight,"CAPABILITY_BLOCKED");
run("FX-AGM-026-runtime-id-mismatch",(m,c)=>{c.runtime_id="other-runtime"},preflight,"CAPABILITY_BLOCKED");
run("FX-AGM-039-attestation-agent-id-mismatch",(m,c,o)=>{o.attestation.agent_id="different-agent"},post,"ROUTING_UNVERIFIED");
run("FX-AGM-040-reasoning-fallback",(m,c,o)=>{o.attestation.effective.reasoning="medium"},post,"SETTING_MISMATCH");
console.log("FX-AGM: "+count+"/"+count+" synthetic fixtures passed");
