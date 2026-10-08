# 컬럼 삭제 가이드

리니지 화면 오른쪽 **SELECT 컬럼 매핑**의 각 결과 컬럼에 **가이드** 버튼이 있다.
이 버튼은 "이 결과 컬럼을 없애려면 무엇을 고쳐야 하나"를 보여준다. 수정은
하지 않는다. 모든 단계에 `file:line`과 그 줄의 내용이 붙는다.

API: `GET /api/v1/statements/:id/column-guide?column=…`. 구현은
`application/ColumnRemovalGuide.js`이고, `ProjectSession#columnRemovalGuide`로
호출한다.

## 1. 추적 (결과 → 원본)

결과 컬럼에서 시작해 SELECT 계층(`analyzer/lineage`)을 따라 내려간다.
- 경로: 파생 테이블, 인라인 뷰, CTE의 출력 항목을 거쳐 원본 `TABLE.COLUMN`까지.
  `tables[].selectId`가 각 단계를 잇는다.
- UNION: 각 브랜치에서 같은 위치의 항목도 함께 추적한다.

## 2. 위치 찾기

statement의 resolved tree를 문서 순서대로 돈다.
- 범위: `<include refid>` 안까지, 그 fragment가 어느 파일에 있든.
- 방법: SQL 텍스트를 lossless SqlLexer로 토큰화하고, 추적된 이름을 찾는다
  (`Q.COL`, 단독 `COL`, 별칭).
- 기록: 참조마다 파일, 줄, 절(SELECT / WHERE / JOIN ON / GROUP BY / ORDER BY …),
  감싸는 동적 태그, fragment.

## 3. 단계

| 묶음 | 단계 | 의미 |
|---|---|---|
| 먼저 확인 | SHARED_FRAGMENT | 그 `<sql>`을 다른 statement도 포함한다. 거기서 지우면 그쪽도 바뀌므로, 분리할지 같이 지울지 정한다. 포함하는 statement 목록이 붙는다 |
| 먼저 확인 | SHARED_RESULT_MAP | 그 resultMap을 다른 statement도 쓴다 |
| 먼저 확인 | CHECK_JAVA | resultClass가 클래스다. 그 필드를 확인한다 |
| 삭제 | REMOVE_SELECT_ITEM | SELECT 항목 (앞뒤 쉼표를 정리한다). 바깥 쿼리가 안쪽 쿼리 항목의 값을 WHERE 등에서 쓰고 있으면 "남겨야 한다"고 표시한다 |
| 삭제 | REMOVE_FRAGMENT / REMOVE_INCLUDE | fragment에 이 컬럼만 있으면 fragment를 통째로, 그리고 그것을 포함하는 `<include refid>` 각각을 지운다 |
| 삭제 | REMOVE_RESULT_MAPPING | resultMap(extends 체인 포함)의 `<result column=…>` |
| 삭제 | REMOVE_DYNAMIC_TAG | 본문이 이 컬럼의 조건뿐인 `<isNotEmpty>` / `<if>` |
| 함께 확인 | CHECK_REFERENCE | WHERE / JOIN / GROUP / ORDER에서도 쓰인다. 결과에서만 빼는 경우엔 손대지 않아도 되지만, 테이블에서 컬럼을 없애려면 함께 고쳐야 한다 |

`SELECT *`로 나오는 컬럼은 따로 안내한다. *를 컬럼 목록으로 바꿔야 한다.

테스트: `test/application/projectSession.test.js`
- 파생 테이블, 공유 fragment, fragment 통째 삭제와 include 위치, 동적 태그,
  resultMap 공유를 확인한다.
- `test/interfaces/sessionApi.test.js`는 API를 확인한다.
