# 업무 관계 보기

호출자가 이미 정제한 관찰을 JSON으로 전달해 확인한다. 이 명령은 Jira·GitHub를 조회하지 않고, 전달된 출처나 상태가 사실인지 검증하거나 완료를 판정하지 않는다. 입력 전에 비밀값·개인정보·원문 응답을 제거한다.

```sh
printf '%s' '{"items":[{"key":"RPL-1","title":"목표","source_ref":"기록 참조","observed_at":"2026-11-18T00:00:00Z"},{"key":"RPL-2","title":"기능"}],"relations":[{"from":"RPL-1","to":"RPL-2","type":"parent"}]}' | node scripts/oh-my-ai.mjs work-view --stdin-json --relations
```

`parent`는 부모에서 자식으로, `membership`은 묶음에서 구성원으로, `blocks`는 선행에서 차단 대상 방향으로 전달한다. `relates`는 대칭인 일반 관련성이다. Parent 관찰이 충돌하거나 순환하면 DRIFT를 표시하며 무엇이 맞는지는 판정하지 않는다. 출처와 시각은 호출자 관찰값이다.

입력은 최대 8 MiB이고 이슈 최대 500개·관계 최대 2000개다. 기존 `work-view --stdin-json` 형식은 그대로 제공한다.

`work-view --stdin-json --jira-observations`는 호출자가 미리 조회하고 개인정보·비밀을 제거한 Jira 이슈 배열 `issues`와 관측시각 `observed_at`을 받는다. 명령은 외부 조회를 수행하지 않으며 결과는 항상 부분 관찰이다. 입력에 없는 이슈와 관계는 미조회이며 완료나 관계 부재의 증거가 아니다. Jira 본문의 의도와 링크가 충돌할 수 있으므로 링크 방향을 자동으로 고치지 않는다.
