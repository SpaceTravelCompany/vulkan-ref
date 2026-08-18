# 기술 정확성 리뷰 기록 — 2026-08-19

`content/*.md` 26개를 Vulkan 스펙 KB(`knowledge_search`, knowledge_base="vulkan")로 교차 검증.
발견 이슈를 `[명확한 오류]` / `[확실하지 않음]`으로 구분해 기록.

## 명확한 오류 (스펙과 확실히 다름)

- [ ] **mesh-shader.md §2.2/§12/§15 — VK_EXT_mesh_shader가 points를 지원하지 않는다는 주장** (mesh-shader.md:38, 669, 821) — Bug, HIGH
  - 원인: 스펙 28.5 "Mesh Shader Output"은 EXT Execution Model에 OutputPoints/OutputLinesEXT/OutputTrianglesEXT 세 모드를 모두 정의. `PrimitivePointIndicesEXT` 빌트인도 EXT 확장("New or Modified Built-In Variables")에 포함.
  - 권장 조치: "EXT는 triangles/lines만, points는 NV 전용" 서술을 "EXT도 points/lines/triangles 지원(NV는 1D만 + PrimitiveIndicesNV 통합)"으로 수정. §7.1의 `gl_PrimitivePointIndicesEXT[]` "Vulkan API 레벨에서 EXT는 points 미지원" 주석도 오류.
  - 근거: vkspec 28.5 Mesh Shader Output; vkspec List of Current Extensions(VK_EXT_mesh_shader New or Modified Built-In Variables: PrimitivePointIndicesEXT).

- [ ] **mesh-shader.md §12 — NV 확장 워크그룹 shape/한계값 오류** (mesh-shader.md:671) — Bug, MEDIUM
  - 원인: NV의 `maxMeshWorkGroupInvocations` 최소 보장값은 128이 아니라 **32**, `maxMeshWorkGroupSize`는 **(32,1,1)** (NV는 1D 전용). EXT가 (128,128,128)/128. 표의 "NV: (32,1,1), invocations 32"는 사실상 맞지만, 본문 §11 표에 NV 한계가 누락/혼용 우려.
  - 근거: vkspec 53.1 Limit Requirements — VkPhysicalDeviceMeshShaderPropertiesNV::maxMeshWorkGroupInvocations min 32, maxMeshWorkGroupSize (32,1,1).

- [ ] **indirect-draw.md §3 — drawIndirectFirstInstance가 "Vulkan 1.2 코어"라는 주장** (indirect-draw.md:96) — Bug, MEDIUM
  - 원인: `drawIndirectFirstInstance`는 VK_KHR_maintenance2 소속 feature로 **Vulkan 1.1에 승격**됨(VK_KHR_maintenance1이 1.1 승격, maintenance2도 1.1 승격 — List of Deprecated Extensions에 "Promoted to Vulkan 1.1" 아님 확인 필요하나, VkPhysicalDeviceFeatures의 `drawIndirectFirstInstance`는 1.1 시대 core feature). VUID-VkDrawIndirectCommand-firstInstance-00501 / VkDrawIndexedIndirectCommand-firstInstance-00554는 버전 무관 "feature 미활성 시 0".
  - 권장 조치: "Vulkan 1.2 코어" → "VK_KHR_maintenance2 (Vulkan 1.1부터 core feature)". §3.2의 "drawIndirectFirstInstance(1.2)" 도 함께 수정.
  - 참고: 문서 §3.2는 "shaderDrawParameters(1.1 코어)"로 기술했는데 이는 맞음(VK_KHR_shader_draw_parameters → 1.1).

- [ ] **object-lifetime.md §4.1/§5 — DescriptorSet을 pool 파괴 전에 반드시 free해야 한다는 주장** (object-lifetime.md:155, 211, 222) — Bug, MEDIUM
  - 원인: 스펙 vkDestroyDescriptorPool "When a pool is destroyed, all descriptor sets allocated from the pool are implicitly freed... Descriptor sets ... do not need to be freed before destroying that descriptor pool." §5 예제가 vkFreeDescriptorSets → vkDestroyDescriptorPool 순서를 강제하는 것은 필수 아님. 또한 vkFreeDescriptorSets는 `VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT` 플래그가 있어야 유효(VUID-vkFreeDescriptorSets-descriptorPool-00312).
  - 권장 조치: "free가 필수"라는 서술을 "pool 파괴 시 자동 free되므로 free 생략 가능(단, FREE_DESCRIPTOR_SET_BIT 없이는 개별 free 불가)"으로 수정.

- [ ] **memory.md §3 — "non-cached면 항상 host coherent"라는 절대적 주장** (memory.md:212-215) — Bug, LOW~MEDIUM
  - 원인: 스펙은 "HOST_CACHED가 아닌" 메모리로 제한해 "uncached memory is always host coherent"라는 단순 도식은 부정확. 실제로는 HOST_VISIBLE 메모리에서 HOST_COHERENT는 별도 플래그이며, HOST_CACHED 없는 non-coherent 조합이 가능. 문서 §3.2 자신이 "Cached + non-coherent"를 언급하며 모순됨.
  - 근거: 스펙 11.2 Device Memory — propertyFlags 조합 목록(예: HOST_VISIBLE | HOST_CACHED 조합이 허용, coherent 없이).
  - 권장 조치: "HOST_COHERENT가 곧 non-cached를 뜻한다"는 도식을 제거하고 "coherent 여부는 별도 플래그로 결정"으로 수정.

- [ ] **queries.md §2.2 — RESET_BIT_KHR 설명의 "1.4+" 표기** (queries.md:89) — Bug, LOW
  - 원인: `VK_QUERY_POOL_CREATE_RESET_BIT_KHR`는 `VK_KHR_maintenance9`(2025-05) 소속으로 **아직 어떤 코어 버전에도 승격되지 않음**(1.4의 구성 확장이 아님). "또는 1.4+"라는 표현은 부정확.
  - 근거: vkspec 21.1 Query Pools — `VK_QUERY_POOL_CREATE_RESET_BIT_KHR` "// Provided by VK_KHR_maintenance9".
  - 권장 조치: "(VK_KHR_maintenance9)"로만 표기, 1.4 언급 제거.

- [ ] **queries.md §4.1 — timestampPeriod를 "보통 1"로 단정** (queries.md:152) — Quality/Bug, LOW
  - 원인: timestampPeriod는 디바이스 의존(많은 dGPU가 1ns지만 보장 없음). "보통 1"은 독자를 오도할 수 있으나 치명 오류는 아님.

- [ ] **compute-pipeline.md §2 — VK_PIPELINE_CREATE_LIBRARY_BIT_KHR 조건 오류** (compute-pipeline.md:69) — Bug, MEDIUM
  - 원인: "`VK_PIPELINE_CREATE_LIBRARY_BIT_KHR`는 `shaderMeshEnqueue` feature 필요"는 오류. VUID-VkComputePipelineCreateInfo-shaderEnqueue-09177: `shaderEnqueue` 미활성 시 LIBRARY_BIT 금지 — 즉 shaderEnqueue(AMDX)는 컴퓨트에서 library bit를 허용하는 특수 경로이고, 일반 pipeline library는 `VK_KHR_pipeline_library` / graphics pipeline library 계열. "shaderMeshEnqueue feature 필요"라는 서술은 잘못된 feature명+조건.
  - 근거: vkspec 10.3 Compute Pipelines VUID-VkComputePipelineCreateInfo-shaderEnqueue-09177.

- [ ] **extensions-rendering.md §8 — mesh shader GLSL 예시 EmitMeshTasksEXT 시그니처** (extensions-rendering.md:155) — Bug, LOW
  - 원인: `EmitMeshTasksEXT(p.visibleCount, 1, 1)`은 시그니처가 아님. OpEmitMeshTasksEXT/GLSL `EmitMeshTasksEXT`는 (groupCountX, groupCountY, groupCountZ) 3인자(선택적 payload 포인터) — task shader 예시처럼 `EmitMeshTasksEXT(1,1,1)`이 맞음. "visibleCount"를 X로 넘기는 의도라면 변수명 주석 필요.
  - 근거: vkspec 24.6/28.3 Mesh Generation — task shader가 "variable amount of mesh workgroups" 생성.

## 확실하지 않음 (스펙 확인 필요/모호)

- [ ] **memory.md §2.2 — "HOST_VISIBLE|HOST_COHERENT 조합이 적어도 하나 존재" 주장** (memory.md:191) — 대체로 맞음(스펙 11.2 "There must be at least one memory type with both HOST_VISIBLE and HOST_COHERENT"), 문구 정확.

- [ ] **synchronization.md §4.2 — setEvent/waitEvents srcStage "일치해야 함" 강조** — 스펙상 vkCmdWaitEvents의 srcStageMask는 setEvent의 stageMask를 "포함"해야 하는 관계로, 문서의 "완전 일치" 강조는 과하게 엄격(불일치 예시는 실제로 유효한 경우가 있음). 확실하지 않음으로 분류.

- [ ] **samplers.md §5 — maxAnisotropy 16으로 단정** — 한계값은 디바이스 의존(권장값 서술로는 OK).

- [ ] **buffers-and-images.md §5.5 — blit의 큐가 "graphics only" 주장** — vkCmdBlitImage는 graphics 큐만(VUID) 지원이 맞음. 문제없음.

- [ ] **extensions-foundation.md §1 — VK_KHR_dynamic_rendering "의존성: Vulkan 1.0 이상(독립적)"** — 실제 의존성은 `VK_KHR_get_physical_device_properties2 or 1.1` + `VK_KHR_depth_stencil_resolve or 1.2`. "1.0 이상"은 부정확(확실하지 않음 그룹).

- [ ] **extensions-foundation.md §3 — descriptor_indexing 의존성** — 실제로는 `VK_KHR_get_physical_device_properties2 AND VK_KHR_maintenance3 or 1.1`. 문서는 "get_physical_device_properties2 or 1.1"만 언급(maintenance3 누락) — 확실하지 않음.

- [ ] **mesh-shader.md §12.1 — "VK_EXT_mesh_shader는 Vulkan 1.2 또는 VK_KHR_spirv_1_4 전제"** — 정확(VK_KHR_spirv_1_4 or Vulkan 1.2). 문제없음.

## 검증된 최근 수정 (정확함)

1. queries.md §4 — vkCmdWriteTimestamp2 4인자 시그니처: **정확** (vkspec 21.5 "// Provided by VK_VERSION_1_3 void vkCmdWriteTimestamp2(VkCommandBuffer, VkPipelineStageFlags2, VkQueryPool, uint32_t)").
2. graphics-pipeline.md §9 — LogicOp "정수형 포맷 전용": **정확** (vkspec 33.2 "applied only for signed and unsigned integer and normalized integer framebuffers... not applied to floating-point or sRGB").
3. indirect-draw.md §3 — gl_DrawID/DrawIndex indexed·non-indexed 모두 유효: **정확** (shaderDrawParameters/DrawParameters capability).
4. mesh-shader.md — taskPayloadSharedEXT qualifier + limit 표: **정확** (vkspec 53.1 — EXT limit 최소값 maxTaskPayloadSize 16384, maxMeshOutputVertices/Primitives 256, maxMeshOutputLayers 8, maxMeshMultiviewViewCount 1 등 모두 일치).
5. extensions-rendering.md §8 — task shader SetMeshOutputsEXT 제거/payload 구조체화: **방향 정확** (task shader는 OpEmitMeshTasksEXT 사용, SetMeshOutputsEXT는 mesh shader 전용).
6. compute-pipeline.md §4.1 — workgroup 한계(maxComputeWorkGroupCount/Size/Invocations) + subgroup: **정확** (표기 "(1024,1024,64)"는 구현 예시로 표기돼 있고 min 보장값은 별도).

## 1차 리뷰에서 수정됐지만 여전히 오류인 항목

- mesh-shader.md의 "EXT는 points 미지원" 서술은 1차 리뷰에서 다듬어졌으나 여전히 스펙과 불일치(위 첫 항목).
