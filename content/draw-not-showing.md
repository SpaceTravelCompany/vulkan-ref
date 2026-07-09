---
title: 그래픽이 안 나올 때
slug: draw-not-showing
---

## 1. Draw 파라미터

`vkCmdDraw`, `vkCmdDrawIndexed` 등에서 **instanceCount는 최소 1**이어야 한다. 인스턴싱을 쓰지 않더라도 1로 설정해야 화면에 그려진다.

> [!TIP]
> 이 페이지의 거의 모든 실수는 **검증 레이어를 켜 두면 실행 전에 잡힙니다.** 표준 위반은 조용히 GPU 쪽에서 누락되어 "안 그려짐"으로 둔갑하기 쉽거든요. `validation-and-debug` 토픽에서 `VK_LAYER_KHRONOS_validation` 활성화 방법을 참고하세요.

```c
// 잘못된 예 — 아무것도 그려지지 않음
vkCmdDraw(cmd, vertexCount, 0, firstVertex, firstInstance);

// 올바른 예
vkCmdDraw(cmd, vertexCount, 1, firstVertex, firstInstance);
```

| 파라미터 | 흔한 실수 |
|---------|----------|
| `vertexCount` / `indexCount` | 0이면 드로우 없음 |
| `instanceCount` | 0이면 드로우 없음 (가장 흔한 함정) |
| `firstVertex` / `firstIndex` | 버퍼 범위를 벗어나면 검증 레이어에서 경고 |

---

## 2. 렌더 패스 / Dynamic Rendering

그래픽스 파이프라인 드로우는 **활성 렌더 패스 안**에서만 유효하다.

```cmdstack
vkCmdBeginRenderPass / vkCmdBeginRendering ← 필수
---
vkCmdBindPipeline(GRAPHICS)
vkCmdBindVertexBuffers / vkCmdBindIndexBuffer
vkCmdBindDescriptorSets
vkCmdDraw(...)
---
vkCmdEndRenderPass / vkCmdEndRendering
```

- Dynamic Rendering(`vkCmdBeginRendering`)을 쓰면 attachment `imageView`·`loadOp`·`storeOp`가 올바른지 확인
- `renderArea.extent`가 0이면 아무것도 그려지지 않음
- 스왑체인 이미지에 그릴 때 **올바른 image index**의 view를 썼는지 확인

---

## 3. 파이프라인 & 뷰포트

```cmdstack
vkCmdBindPipeline(cmd, GRAPHICS, pipeline) ← 필수
vkCmdSetViewport / vkCmdSetScissor ← dynamic state면 필수
vkCmdDraw(...)
```

- 파이프라인이 **GRAPHICS** 바인드 포인트인지
- `VK_DYNAMIC_STATE_VIEWPORT` / `SCISSOR`를 켰다면 `vkCmdSetViewport`·`vkCmdSetScissor` 호출 여부
- 뷰포트가 화면 밖이거나 scissor가 0×0이면 보이지 않음
- **컬링**: `VK_CULL_MODE_BACK_BIT` + 잘못된 `frontFace`면 삼각형이 전부 컬링될 수 있음

---

## 4. 버텍스 / 인덱스 버퍼

- `vkCmdBindVertexBuffers`로 올바른 버퍼·오프셋 바인딩
- `vkCmdBindIndexBuffer` + `vkCmdDrawIndexed` 사용 시 인덱스 타입(`UINT16`/`UINT32`) 일치
- 버텍스 입력 설명(`VkPipelineVertexInputStateCreateInfo`)과 실제 버퍼 레이아웃 일치
- GPU 메모리에 업로드되었는지, staging → device local 복사 후 **배리어**로 가시성 확보했는지

---

## 5. Descriptor / Push Constant

셰이더가 UBO·텍스처·샘플러를 읽는다면:

```cmdstack
VkDescriptorSetLayout 정의
---
VkDescriptorSet 할당 + vkUpdateDescriptorSets
---
vkCmdBindDescriptorSets(cmd, ..., pipelineLayout)
---
vkCmdDraw
```

- `set` / `binding` 번호가 GLSL `layout(set=, binding=)`와 일치
- 파이프라인 레이아웃이 descriptor set layout과 호환
- Push constant 크기·오프셋이 셰이더 `layout(push_constant)`와 일치

---

## 6. 셰이더 출력 & 깊이

- 프래그먼트가 **알파 0**이거나 discard하면 투명
- 깊이 테스트(`depthTestEnable`) + `depthWriteEnable` + clear 값으로 전부 가려짐
- `colorWriteMask`가 0이면 컬러 버퍼에 쓰지 않음
- 스왑체인 **surface format**과 attachment format·blend 설정 호환

---

## 7. 동기화 & 제출

```cmdstack
vkAcquireNextImageKHR ← 스왑체인 이미지 획득
---
커맨드 버퍼 기록 (렌더링)
---
vkQueueSubmit ← semaphore/fence
---
vkQueuePresentKHR
```

- 커맨드 버퍼를 `vkEndCommandBuffer` 후 `vkQueueSubmit` 했는지
- acquire semaphore를 submit의 wait로 연결했는지
- fence로 프레임 리소스 재사용 타이밍을 맞췄는지
- 검증 레이어(`VK_LAYER_KHRONOS_validation`)를 켜면 대부분의 실수가 로그로 나온다

---

## 8. 빠른 체크리스트

| # | 확인 항목 |
|---|----------|
| 1 | `instanceCount >= 1` |
| 2 | 렌더 패스 / BeginRendering 활성 |
| 3 | Graphics 파이프라인 바인딩 |
| 4 | Viewport / Scissor 설정 |
| 5 | 버텍스(·인덱스) 버퍼 바인딩 & GPU 업로드 |
| 6 | Descriptor set 바인딩 |
| 7 | 커맨드 버퍼 submit + present |
| 8 | 검증 레이어 메시지 |
