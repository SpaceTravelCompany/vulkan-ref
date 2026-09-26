---
title: 그래픽이 안 나올 때
slug: draw-not-showing
---

## 1. Draw 파라미터

`vkCmdDraw`, `vkCmdDrawIndexed` 등에서 **`instanceCount`는 최소 1**이어야 한다. 인스턴싱을 사용하지 않더라도 1로 설정해야 화면에 정상적으로 렌더링된다.

> [!TIP]
> 이 문서에서 다루는 실수는 대부분 **검증 레이어를 활성화하면 사전에 감지**할 수 있다. 규격 위반이 발생하면 GPU 측에서 렌더링이 조용히 누락되어 원인 파악이 어려워지기 쉽다. 자세한 설정 방법은 `validation-and-debug` 토픽의 `VK_LAYER_KHRONOS_validation` 활성화 안내를 참고한다.

```c
// 잘못된 예 — 아무것도 그려지지 않음
vkCmdDraw(cmd, vertexCount, 0, firstVertex, firstInstance);

// 올바른 예
vkCmdDraw(cmd, vertexCount, 1, firstVertex, firstInstance);
```

| 파라미터 | 흔한 실수 |
|---------|----------|
| `vertexCount` / `indexCount` | 0이면 드로우 명령이 수행되지 않음 |
| `instanceCount` | 0이면 아무것도 그려지지 않음 (가장 흔한 함정) |
| `firstVertex` / `firstIndex` | 버퍼 범위를 벗어나면 검증 레이어 경고 발생 |

---

## 2. 렌더 패스 / Dynamic Rendering

그래픽스 파이프라인의 드로우 명령은 **활성화된 렌더 패스 내부**에서만 유효하다.

```flowchart
flowchart TD
  A(["vkCmdBeginRenderPass / vkCmdBeginRendering — 필수"])
  B(["vkCmdBindPipeline(GRAPHICS)"])
  C(["vkCmdBindVertexBuffers / vkCmdBindIndexBuffer"])
  D(["vkCmdBindDescriptorSets"])
  E(["vkCmdDraw(...)"])
  F(["vkCmdEndRenderPass / vkCmdEndRendering"])
  A --> B --> C --> D --> E --> F
```

- Dynamic Rendering(`vkCmdBeginRendering`) 사용 시 어태치먼트의 `imageView`, `loadOp`, `storeOp` 설정 확인
- `renderArea.extent`가 0이면 아무것도 렌더링되지 않음
- 스왑체인 이미지에 렌더링할 때 **올바른 이미지 인덱스**의 뷰를 참조하는지 확인

---

## 3. 파이프라인 & 뷰포트

```flowchart
flowchart TD
  A(["vkCmdBindPipeline(cmd, GRAPHICS, pipeline) — 필수"])
  B(["vkCmdSetViewport / vkCmdSetScissor — 동적 상태 활성화 시 필수"])
  C(["vkCmdDraw(...)"])
  A --> B --> C
```

- 파이프라인 바인드 포인트가 **`VK_PIPELINE_BIND_POINT_GRAPHICS`**인지 확인
- `VK_DYNAMIC_STATE_VIEWPORT` 또는 `VK_DYNAMIC_STATE_SCISSOR`를 활성화한 경우 `vkCmdSetViewport`, `vkCmdSetScissor` 호출 여부 확인
- 뷰포트 영역이 화면 밖이거나 시저(Scissor) 사각형 크기가 0×0인지 확인
- **컬링(Culling)**: `VK_CULL_MODE_BACK_BIT` 설정 시 정점 와인딩(`frontFace`) 방향이 어긋나면 삼각형이 전부 컬링될 수 있음

---

## 4. 버텍스 / 인덱스 버퍼

- `vkCmdBindVertexBuffers`로 올바른 버퍼와 오프셋을 바인딩했는지 확인
- `vkCmdBindIndexBuffer` 및 `vkCmdDrawIndexed` 사용 시 인덱스 타입(`VK_INDEX_TYPE_UINT16`/`VK_INDEX_TYPE_UINT32`) 일치 여부 확인
- 버텍스 입력 명세(`VkPipelineVertexInputStateCreateInfo`)와 실제 버퍼 데이터 레이아웃의 일치 여부 확인
- GPU 메모리 업로드 완료 여부 확인 (스테이징 버퍼에서 디바이스 로컬 메모리로 복사한 뒤 **파이프라인 배리어**로 메모리 가시성을 확보했는지 점검)

---

## 5. Descriptor / Push Constant

셰이더가 UBO, 텍스처, 샘플러를 참조하는 경우:

```flowchart
flowchart TD
  A["VkDescriptorSetLayout 정의"]
  B(["VkDescriptorSet 할당 및 vkUpdateDescriptorSets"])
  C(["vkCmdBindDescriptorSets(cmd, ..., pipelineLayout)"])
  D(["vkCmdDraw"])
  A --> B --> C --> D
```

- 디스크립터의 `set` 및 `binding` 번호가 GLSL `layout(set=, binding=)` 선언과 일치하는지 확인
- 파이프라인 레이아웃이 디스크립터 세트 레이아웃과 호환되는지 확인
- 푸시 상수(Push Constant) 크기와 오프셋이 셰이더 `layout(push_constant)` 선언과 일치하는지 확인

---

## 6. 셰이더 출력 & 깊이

- 프래그먼트 알파 값이 0이거나 discard가 실행되어 투명해졌는지 확인
- 깊이 테스트(`depthTestEnable`), 깊이 기록(`depthWriteEnable`), 클리어 값 설정으로 인해 화면 전체가 가려졌는지 확인
- `colorWriteMask`가 0으로 설정되어 컬러 버퍼 기록이 차단되었는지 확인
- 스왑체인 **표면 포맷(Surface Format)**과 렌더 타깃 포맷 및 블렌드 설정의 호환 여부 확인

---

## 7. 동기화 & 제출

```flowchart
flowchart TD
  A(["vkAcquireNextImageKHR — 스왑체인 이미지 획득"])
  B["커맨드 버퍼 기록 (렌더링)"]
  C(["vkQueueSubmit — semaphore/fence 동기화"])
  D(["vkQueuePresentKHR — 화면 표시"])
  A --> B --> C --> D
```

- 커맨드 버퍼 기록을 완료한 뒤 `vkEndCommandBuffer`를 호출하고 `vkQueueSubmit`으로 제출했는지 확인
- `vkAcquireNextImageKHR`의 이미지 획득 세마포어를 `vkQueueSubmit`의 대기 세마포어로 올바르게 연결했는지 확인
- 펜스(Fence)를 활용해 프레임별 리소스 재사용 시점을 올바르게 동기화했는지 확인
- 검증 레이어(`VK_LAYER_KHRONOS_validation`)를 활성화하면 대부분의 규격 위반을 로그로 즉시 확인할 수 있다.

---

## 8. 빠른 체크리스트

| 번호 | 점검 항목 | 점검 내용 |
|---|----------|----------|
| 1 | 드로우 파라미터 | `instanceCount >= 1` 설정 여부 |
| 2 | 렌더 패스 | 활성 렌더 패스 또는 `vkCmdBeginRendering` 내부 실행 여부 |
| 3 | 파이프라인 바인딩 | Graphics 바인드 포인트 및 파이프라인 바인딩 완료 여부 |
| 4 | 뷰포트 / 시저 | 동적 상태 설정 시 `vkCmdSetViewport`, `vkCmdSetScissor` 호출 여부 |
| 5 | 정점 / 인덱스 버퍼 | 버퍼 바인딩, 포맷 일치 및 배리어를 통한 메모리 가시성 확보 여부 |
| 6 | 디스크립터 세트 | 디스크립터 세트 바인딩 및 셰이더 레이아웃 일치 여부 |
| 7 | 커맨드 제출 및 표시 | `vkEndCommandBuffer` 완료, `vkQueueSubmit` 제출 및 `vkQueuePresentKHR` 호출 여부 |
| 8 | 검증 레이어 메시지 | `VK_LAYER_KHRONOS_validation` 경고 및 오류 로그 확인 |
