---
title: Validation & Debug
slug: validation-and-debug
---

## 소개

Vulkan은 명시적 저수준 API이므로 규격을 위반하더라도 GPU가 오류를 즉각 보고하지 않고 의도치 않게 작동할 수 있다. **검증 레이어(Validation Layer)**는 규격 위반, 동기화 누락, 리소스 수명 오류 등을 런타임에 감지하는 핵심 디버깅 도구다. 또한 `VK_EXT_debug_utils` 확장은 콜백 함수, 객체 식별 이름 지정, GPU 타임라인 라벨링 등 상세한 디버깅 인터페이스를 제공한다.

> **용어 정리**
> - **Validation Layer**: Vulkan 함수 호출을 가로채 규격 위반을 검사하는 계층. `VK_LAYER_KHRONOS_validation`이 표준 레이어 모음이다.
> - **Messenger**: 검증, 성능 경고, 일반 메시지를 수신하는 콜백 인터페이스 (`VK_EXT_debug_utils`).
> - **VUID**: Vulkan Unique ID. `VUID-VkBufferCreateInfo-usage-09500`처럼 각 유효성 검증 규칙에 부여된 고유 식별자.
> - **Debug Region**: 커맨드 버퍼나 큐 작업 구간에 부여하는 식별 라벨. RenderDoc이나 GPU 프로파일러에서 시각화된다.
> - **GPU-assisted Validation**: 셰이더 바이트코드를 계측하여 GPU 실행 시점의 잘못된 리소스 접근 등을 검출하는 기능.

이 문서는 검증 레이어 활성화, 메신저 콜백 구성, 객체 명명, 디버그 라벨 활용 및 실전 디버깅 지침을 순서대로 다룬다.

---

## 1. 전체 흐름

```flowchart
flowchart TD
  A["VkInstance 생성 시 VK_EXT_debug_utils 및 VK_LAYER_KHRONOS_validation 요청"]
  B["pNext 체인: VkDebugUtilsMessengerCreateInfoEXT — 인스턴스 소멸까지 모든 메시지 수신"]
  C["pNext 체인: VkValidationFeaturesEXT — Best Practices, 동기화 검증 활성화"]
  D(["vkCreateInstance"])
  E["[인스턴스 소멸 전까지] 콜백으로 디버그 메시지 수신"]
  F["messageSeverity: ERROR, WARNING, INFO"]
  G["messageType: VALIDATION, GENERAL, PERFORMANCE"]
  H["(개별 객체에 이름 지정)"]
  I(["vkSetDebugUtilsObjectNameEXT(VK_OBJECT_TYPE_IMAGE, handle, 'HDR_Target')"])
  J["(커맨드 버퍼에 라벨 기록)"]
  K(["vkCmdBeginDebugUtilsLabelEXT(cmd, 'Shadow Pass', color)"])
  L["... 드로우 명령 기록 ..."]
  M(["vkCmdEndDebugUtilsLabelEXT(cmd)"])
  A --> B --> C --> D --> E
  E --> F
  E --> G
  E --> H --> I
  I --> J --> K --> L --> M
```

**핵심 원칙:**

- 인스턴스 생성 시점부터 소멸 시점까지 발생하는 모든 초기화 및 정리 메시지를 수신하려면 `VkInstanceCreateInfo`의 `pNext` 체인에 메신저 정보를 연결해야 한다.
- 릴리스 빌드에서는 불필요한 오버헤드를 방지하기 위해 검증 레이어를 비활성화하고 `VK_EXT_debug_utils` 확장도 제외하는 것이 일반적이다.
- 주요 객체에 고유한 이름을 지정하면 검증 메시지 발생 시 원인 리소스를 즉시 식별할 수 있다.

---

## 2. Validation Layer

### 2.1. `VK_LAYER_KHRONOS_validation`

- Khronos 및 LunarG의 표준 검증 레이어 모음이다. 핵심 API 규격 검사(`Core Checks`), 스레드 안전성(`Thread Safety`), 객체 수명 추적(`Object Lifetime`), 셰이더 계측 검증(`Shader Instrumentation`) 등을 통합 제공한다.
- **Vulkan SDK 설치 시 기본 포함**된다. SDK가 없는 환경에서는 별도로 런타임 레이어를 구성해야 한다.
- 인스턴스 생성 시 `ppEnabledLayerNames`에 명시하거나 환경 변수를 통해 활성화할 수 있다.
  - `VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation`

```c
// 명시적 레이어 활성화
VkInstanceCreateInfo ici{};
ici.enabledLayerCount = 1;
ici.ppEnabledLayerNames = (const char*[]){"VK_LAYER_KHRONOS_validation"};
```

> [!TIP]
> 디버그 빌드에서는 환경 변수 대신 코드에서 명시적으로 레이어를 활성화하는 방식을 권장한다. 환경 변수 설정에만 의존하면 CI 환경이나 다른 사용자 머신에서 검증이 누락될 수 있다.

### 2.2. `VK_EXT_validation_features` — 세부 기능 제어

`VkValidationFeaturesEXT` 구조체를 `VkInstanceCreateInfo::pNext`에 연결하여 개별 검증 기능을 활성화하거나 비활성화한다.

```c
VkValidationFeaturesEXT vf{};
vf.sType = VK_STRUCTURE_TYPE_VALIDATION_FEATURES_EXT;

// 활성화할 기능 지정
VkValidationFeatureEnableEXT enables[] = {
    VK_VALIDATION_FEATURE_ENABLE_BEST_PRACTICES_EXT,
    VK_VALIDATION_FEATURE_ENABLE_SYNCHRONIZATION_VALIDATION_EXT,
    VK_VALIDATION_FEATURE_ENABLE_GPU_ASSISTED_EXT,
};
vf.enabledValidationFeatureCount = 3;
vf.pEnabledValidationFeatures = enables;

// 비활성화할 기능 지정 (선택 사항)
VkValidationFeatureDisableEXT disables[] = {
    // VK_VALIDATION_FEATURE_DISABLE_THREAD_SAFETY_EXT,  // 단일 스레드 애플리케이션인 경우
};
vf.disabledValidationFeatureCount = 0;
vf.pDisabledValidationFeatures = disables;

ici.pNext = &vf;
```

| 활성화 플래그 | 설명 |
|--------------|------|
| `GPU_ASSISTED_EXT` | 셰이더 코드를 계측하여 GPU 실행 시점의 잘못된 인덱스 접근 등을 검출 (성능 비용 높음) |
| `GPU_ASSISTED_RESERVE_BINDING_SLOT_EXT` | GPU 계측 검증에 사용할 디스크립터 세트 슬롯 1개를 사전에 예약 |
| `BEST_PRACTICES_EXT` | 명시적인 규격 위반은 아니지만 성능이나 호환성에 잠재적 위험이 있는 패턴 경고 |
| `DEBUG_PRINTF_EXT` | 셰이더 내부의 `debugPrintfEXT` 호출 출력을 디버그 콜백으로 전달 |
| `SYNCHRONIZATION_VALIDATION_EXT` | 파이프라인 배리어 및 세마포어 누락으로 인한 데이터 레이스 검출 (권장) |

| 비활성화 플래그 | 설명 |
|---------------|------|
| `ALL_EXT` | 모든 검증 기능을 비활성화 |
| `SHADERS_EXT` | 셰이더 모듈 검증 비활성화 (검증된 SPIR-V 바이너리 전용) |
| `THREAD_SAFETY_EXT` | 멀티스레드 안전성 검사 비활성화 |
| `API_PARAMETERS_EXT` | 함수 파라미터 유효성 검사 비활성화 |
| `OBJECT_LIFETIMES_EXT` | 객체 수명 및 소멸 순서 검사 비활성화 |
| `CORE_CHECKS_EXT` | 핵심 규격 검사 비활성화 (**`SHADERS_EXT`도 함께 비활성화됨**) |
| `UNIQUE_HANDLES_EXT` | 고유 핸들 래핑 비활성화 |
| `SHADER_VALIDATION_CACHE_EXT` | 셰이더 검증 결과 캐시 비활성화 |

> **스펙 원문 (VUID-VkValidationFeaturesEXT-pEnabledValidationFeatures-02967)**
> "If `pEnabledValidationFeatures` array contains `GPU_ASSISTED_RESERVE_BINDING_SLOT_EXT`, then it must also contain `GPU_ASSISTED_EXT` or `DEBUG_PRINTF_EXT`."
> 바인딩 슬롯 예약을 활성화하는 경우, 해당 슬롯을 사용하는 `GPU_ASSISTED_EXT` 또는 `DEBUG_PRINTF_EXT`도 반드시 함께 활성화해야 한다.

> **스펙 발췌**
> "Disabling checks such as parameter validation and object lifetime validation prevents the reporting of error conditions that can cause other validation checks to behave incorrectly or crash. Some validation checks assume that their inputs are already valid and do not always revalidate them."
> 파라미터나 수명 검증을 비활성화하면 다른 검증 로직이 잘못 동작하거나 비정상 종료될 위험이 있다. 필수 검증 항목(`API_PARAMETERS`, `OBJECT_LIFETIMES`, `CORE_CHECKS`)은 활성 상태를 유지해야 한다.

### 2.3. 개발 단계별 권장 설정

| 환경 | 레이어 | 활성화 플래그 | 비활성화 플래그 |
|------|-------|--------------|----------------|
| **일반 개발** | `VK_LAYER_KHRONOS_validation` | `BEST_PRACTICES`, `SYNCHRONIZATION_VALIDATION` | 없음 |
| **GPU 결함 추적** | `VK_LAYER_KHRONOS_validation` | 위 항목 + `GPU_ASSISTED` 및 `GPU_ASSISTED_RESERVE_BINDING_SLOT` | 없음 |
| **성능 프로파일링** | 비활성화 | 없음 | 없음 |
| **릴리스 빌드** | 비활성화 | 없음 | 없음 |

---

## 3. `VK_EXT_debug_utils` — 메신저 콜백

> **스펙 발췌**
> "The application should always return `VK_FALSE`. The `VK_TRUE` value is reserved for use in layer development."
> 애플리케이션 콜백은 항상 `VK_FALSE`를 반환해야 한다. `VK_TRUE`는 레이어 개발 전용 반환값이다.

### 3.1. 콜백 함수 등록

```c
typedef VkBool32 (VKAPI_PTR *PFN_vkDebugUtilsMessengerCallbackEXT)(
    VkDebugUtilsMessageSeverityFlagBitsEXT       messageSeverity,
    VkDebugUtilsMessageTypeFlagsEXT              messageTypes,
    const VkDebugUtilsMessengerCallbackDataEXT*  pCallbackData,
    void*                                        pUserData);

// 인스턴스 생성 정보의 pNext 체인에 메신저 연결
VkDebugUtilsMessengerCreateInfoEXT mci{};
mci.sType = VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT;
mci.messageSeverity =
    VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT |
    VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT;
mci.messageType =
    VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT |
    VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT |
    VK_DEBUG_UTILS_MESSAGE_TYPE_PERFORMANCE_BIT_EXT;
mci.pfnUserCallback = debugCallback;
mci.pUserData = nullptr;

VkInstanceCreateInfo ici{};
ici.pNext = &mci;  // VkValidationFeaturesEXT와 함께 연결 가능
vkCreateInstance(&ici, nullptr, &instance);
```

> **스펙 원문 (VUID-PFN_vkDebugUtilsMessengerCallbackEXT-None-04769)**
> "The callback must not make calls to any Vulkan commands."
> 콜백 내부에서 Vulkan 명령어를 호출해서는 안 된다. 로깅이나 원자적(Atomic) 플래그 설정 등 비-Vulkan 작업만 수행해야 한다.

### 3.2. 콜백 호출 조건

1. 발생한 이벤트의 `messageSeverity`와 등록된 메신저의 `messageSeverity`의 비트 AND 연산 결과가 0이면 무시한다.
2. 0이 아닌 경우 `messageType`에 대해서도 동일한 비트 검사를 수행한다.
3. 두 조건을 모두 만족하면 콜백 함수가 호출된다.

### 3.3. 콜백 데이터 구조체 — `VkDebugUtilsMessengerCallbackDataEXT`

```c
typedef struct VkDebugUtilsMessengerCallbackDataEXT {
    VkStructureType                              sType;
    const void*                                  pNext;
    VkDebugUtilsMessengerCallbackDataFlagsEXT    flags;
    const char*                                  pMessageIdName;     // VUID 문자열 (검증 메시지인 경우)
    int32_t                                      messageIdNumber;
    const char*                                  pMessage;           // 상세 오류 설명 문자열
    uint32_t                                     queueLabelCount;
    const VkDebugUtilsLabelEXT*                  pQueueLabels;
    uint32_t                                     cmdBufLabelCount;
    const VkDebugUtilsLabelEXT*                  pCmdBufLabels;
    uint32_t                                     objectCount;
    const VkDebugUtilsObjectNameInfoEXT*         pObjects;           // 연관된 Vulkan 객체 목록
} VkDebugUtilsMessengerCallbackDataEXT;
```

- `pMessageIdName`은 **VUID**(예: `VUID-VkBufferCreateInfo-usage-09500`)를 포함하므로, 이 문자열로 Vulkan 명세서를 검색하여 정확한 위반 조건을 확인할 수 있다.
- `pObjects`에 포함된 객체는 `vkSetDebugUtilsObjectNameEXT`로 부여한 식별 이름을 함께 출력한다.

### 3.4. 메시지 유형 분류

| 유형 | 의미 | 발생 경로 |
|------|------|----------|
| `GENERAL` | 레이어와 무관한 일반 시스템 알림 | 드라이버, 로더, 애플리케이션의 `vkSubmitDebugUtilsMessageEXT` 호출 |
| `VALIDATION` | Vulkan API 규격 위반 | `VK_LAYER_KHRONOS_validation` |
| `PERFORMANCE` | 잠재적인 성능 저하 패턴 알림 | `VK_LAYER_KHRONOS_validation`의 Best Practices 검사 |
| `DEVICE_ADDRESS_BINDING_EXT` | 버퍼 디바이스 주소 바인딩 알림 | 디바이스 주소 바인딩 관련 확장 |

---

## 4. 객체 식별 이름 지정 — `vkSetDebugUtilsObjectNameEXT`

검증 메시지에 핸들 주소(`Image 0xc0dec0de...`)만 출력되면 어떤 리소스에서 문제가 발생했는지 식별하기 어렵다. 리소스 생성 시 의미 있는 이름을 부여하면 문제를 빠르게 추적할 수 있다.

```c
// 함수 포인터 로드
PFN_vkSetDebugUtilsObjectNameEXT pfnSetName =
    (PFN_vkSetDebugUtilsObjectNameEXT)vkGetDeviceProcAddr(device, "vkSetDebugUtilsObjectNameEXT");

VkDebugUtilsObjectNameInfoEXT nameInfo{};
nameInfo.sType        = VK_STRUCTURE_TYPE_DEBUG_UTILS_OBJECT_NAME_INFO_EXT;
nameInfo.objectType   = VK_OBJECT_TYPE_IMAGE;
nameInfo.objectHandle = (uint64_t)image;
nameInfo.pObjectName  = "HDR_Target";
pfnSetName(device, &nameInfo);
```

이름을 지정하면 검증 메시지에 객체 이름이 함께 표시된다:

```
Image 'HDR_Target' (0xc0dec0dedeadbeef) is used in a command buffer
with no memory bound to it.
```

### 4.1. 주요 객체별 명명 기준

| 객체 타입 | 명명 권장 예시 |
|-----------|---------------|
| `VkInstance` | `"AppName_Instance"` |
| `VkDevice` | `"Main_Device"`, `"GPU0"` |
| `VkQueue` | `"GraphicsQueue"`, `"PresentQueue"`, `"ComputeQueue"` |
| `VkCommandPool` / `VkCommandBuffer` | `"MainRenderPool"` / `"Frame0_RenderCmd"` |
| `VkBuffer` | `"VertexBuffer_StaticMesh"`, `"UBO_CameraData"` |
| `VkImage` | `"HDR_ColorTarget"`, `"ShadowDepthMap_Cascade0"` |
| `VkImageView` | `"HDR_ColorTarget_RTV"`, `"ShadowDepthMap_SRV"` |
| `VkSampler` | `"LinearClampSampler"`, `"AnisotropicRepeatSampler"` |
| `VkPipeline` | `"OpaqueGeometry_Pipeline"`, `"DeferredLighting_Pipeline"` |
| `VkPipelineLayout` | `"GlobalScene_PipelineLayout"` |
| `VkDescriptorSet` | `"PerFrameData_Set0"` |
| `VkRenderPass` / `VkFramebuffer` | `"Main_RenderPass"`, `"Frame0_Framebuffer"` |
| `VkSemaphore` / `VkFence` | `"ImageAvailable_Semaphore"`, `"InFlight_Fence0"` |
| `VkSwapchainKHR` | `"MainWindow_Swapchain"` |

> **스펙 발췌**
> "The graphicsPipelineLibrary feature allows the specification of pipelines without the creation of `VkShaderModule` objects beforehand... `VkDebugUtilsObjectNameInfoEXT` can be included in the pNext chain of `VkPipelineShaderStageCreateInfo`..."
> `graphicsPipelineLibrary`를 사용하여 셰이더 모듈을 사전에 생성하지 않고 파이프라인을 구성하는 경우, `VkPipelineShaderStageCreateInfo`의 `pNext` 체인에 `VkDebugUtilsObjectNameInfoEXT`를 포함하여 셰이더 스테이지 이름을 직접 지정할 수 있다.

### 4.2. 성능 고려사항

객체 이름을 등록하는 작업은 드라이버 및 레이어의 내부 메타데이터에 항목을 추가하는 수준이므로 GPU 렌더링 성능에 영향을 주지 않는다. 다만 문자열 복사 비용이 발생하므로 렌더링 루프 내부에서 매 프레임 이름을 갱신하는 것은 피해야 하며, 리소스 생성 직후 1회 설정하는 것이 바람직하다.

---

## 5. Debug Region — GPU 타임라인 라벨링

RenderDoc, Vulkan Configurator, NVIDIA Nsight Graphics 등의 외부 프로파일링 도구는 **커맨드 버퍼 및 큐에 삽입된 디버그 라벨**을 타임라인상에 시각화한다.

### 5.1. 큐 라벨

```c
PFN_vkQueueBeginDebugUtilsLabelEXT pfnBegin =
    (PFN_vkQueueBeginDebugUtilsLabelEXT)vkGetInstanceProcAddr(instance, "vkQueueBeginDebugUtilsLabelEXT");
PFN_vkQueueEndDebugUtilsLabelEXT pfnEnd =
    (PFN_vkQueueEndDebugUtilsLabelEXT)vkGetInstanceProcAddr(instance, "vkQueueEndDebugUtilsLabelEXT");

VkDebugUtilsLabelEXT label{};
label.sType      = VK_STRUCTURE_TYPE_DEBUG_UTILS_LABEL_EXT;
label.pLabelName = "Frame 1234";
label.color[0]   = 1.0f; label.color[1] = 0.5f; label.color[2] = 0.0f; label.color[3] = 1.0f; // RGBA

pfnBegin(queue, &label);
vkQueueSubmit(queue, ...);  // 제출 작업에 라벨 부착
pfnEnd(queue);
```

### 5.2. 커맨드 버퍼 라벨

```c
PFN_vkCmdBeginDebugUtilsLabelEXT pfnCmdBegin = ...;
PFN_vkCmdEndDebugUtilsLabelEXT pfnCmdEnd = ...;

pfnCmdBegin(cmd, &label);   // 예: pLabelName = "Shadow Pass", color = {0, 1, 0, 1}
vkCmdBeginRenderPass(cmd, ...);
// 드로우 호출 기록...
vkCmdEndRenderPass(cmd);
pfnCmdEnd(cmd);
```

라벨은 중첩(Nesting)이 가능하며, 프로파일러 타임라인에서 계층 구조 트리로 표시된다.

### 5.3. 단일 시점 마커 — `vkCmdInsertDebugUtilsLabelEXT`

구간이 아닌 특정 시점을 마킹할 때 사용한다. 프로파일러 타임라인에 단일 시점 마커로 표시된다.

```c
VkDebugUtilsLabelEXT marker{};
marker.sType      = VK_STRUCTURE_TYPE_DEBUG_UTILS_LABEL_EXT;
marker.pLabelName = "Compute Dispatch Completed";
pfnCmdInsert(cmd, &marker);
```

### 5.4. 성능 고려사항

- 라벨 함수 호출은 기록 시점에 메타데이터만 추가하므로 GPU 렌더링 파이프라인에 직접적인 부하를 주지 않는다.
- 디버그 라벨은 프로덕션 환경에서도 외부 프로파일러 디버깅에 유용하므로 유지하는 것을 권장한다. 비활성화하려면 인스턴스 확장 목록에서 `VK_EXT_debug_utils`를 제외하거나 전처리기 매크로로 호출을 제어한다. (`VK_EXT_debug_utils`는 인스턴스 확장이다.)

---

## 6. `vkSubmitDebugUtilsMessageEXT` — 애플리케이션 메시지 주입

사용자 정의 메시지를 **검증 레이어 콜백 파이프라인에 직접 주입**할 수 있다. 자체 로깅 시스템이나 외부 분석 도구와 연계할 때 유용하다.

```c
PFN_vkSubmitDebugUtilsMessageEXT pfnSubmit =
    (PFN_vkSubmitDebugUtilsMessageEXT)vkGetInstanceProcAddr(instance, "vkSubmitDebugUtilsMessageEXT");

VkDebugUtilsMessengerCallbackDataEXT data{};
data.sType           = VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CALLBACK_DATA_EXT;
data.pMessageIdName  = "Application.SceneReload";
data.messageIdNumber = 0;
data.pMessage        = "Scene resource reload started";

pfnSubmit(instance,
    VK_DEBUG_UTILS_MESSAGE_SEVERITY_INFO_BIT_EXT,
    VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT,
    &data);
```

---

## 7. 외부 도구 연계

- **RenderDoc**: `VK_EXT_debug_utils`로 설정한 객체 이름과 디버그 라벨이 RenderDoc의 리소스 인스펙터(Resource Inspector) 및 타임라인에 그대로 반영된다.
- **Vulkan Configurator (vkconfig)**: SDK에 포함된 GUI 도구로, 코드 수정 없이 검증 레이어의 세부 옵션(GPU 계측, 동기화 검증 등)을 전역 설정할 수 있다.
- **NVIDIA Nsight Graphics**: 라벨을 기반으로 각 렌더 패스 및 커맨드 구간별 GPU 성능 병목을 정밀 분석할 수 있다.

> [!TIP]
> RenderDoc으로 프레임을 캡처할 때 검증 레이어가 활성화되어 있으면 캡처 파일 로드 시 검증 메시지가 함께 기록되어 디버깅에 유용한 단서를 제공한다.

---

## 8. 자주 발생하는 실수 및 점검 항목

### 8.1. 인스턴스 및 메신저

- [ ] `VK_EXT_debug_utils` 확장을 요청하지 않아 메신저 관련 함수 포인터가 `nullptr`을 반환하는 경우
- [ ] 메신저 콜백 함수 내부에서 Vulkan API 함수를 호출하는 경우 (VUID-PFN_vkDebugUtilsMessengerCallbackEXT-None-04769 위반)
- [ ] 메신저 콜백 함수에서 `VK_TRUE`를 반환하는 경우 (스펙은 "should always return VK_FALSE" — 레이어가 메시지를 전달하지 않을 수 있음)
- [ ] `vkCreateDebugUtilsMessengerEXT`를 인스턴스 생성 이후에 호출하여 인스턴스 생성 중 발생하는 메시지를 유실하는 경우 (`VkInstanceCreateInfo::pNext`에 체이닝하여 해결)
- [ ] 메신저를 명시적으로 파괴하지 않고 `vkDestroyInstance`를 호출하는 경우 (VUID-vkDestroyInstance-instance-00629: 자식 객체는 인스턴스 파괴 전에 명시적으로 파괴해야 한다)
- [ ] 메신저 콜백이 활성 상태인 동안 `vkDestroyDebugUtilsMessengerEXT`를 호출하는 경우 (콜백 실행 중 파괴는 미정의 동작)

### 8.2. Validation Features 설정

- [ ] `GPU_ASSISTED_RESERVE_BINDING_SLOT_EXT`만 활성화하고 `GPU_ASSISTED_EXT` 또는 `DEBUG_PRINTF_EXT`를 활성화하지 않은 경우 (VUID-VkValidationFeaturesEXT-pEnabledValidationFeatures-02967)
- [ ] `CORE_CHECKS_EXT`를 비활성화하여 `SHADERS_EXT`까지 자동으로 비활성화되는 현상 (셰이더 검증만 끄려면 `SHADERS_EXT`만 명시)
- [ ] 필수 검증 항목(`API_PARAMETERS`, `OBJECT_LIFETIMES`, `CORE_CHECKS`)을 비활성화하여 레이어 전체의 안정성을 저해하는 경우
- [ ] `VK_LAYER_KHRONOS_validation`을 환경 변수에만 의존하여 CI 환경에서 검증이 누락되는 경우

### 8.3. 객체 명명

- [ ] 이름 문자열이 널로 종료되는 유효한 UTF-8 문자열이 아닌 경우
- [ ] `pObjectName`을 `NULL`로 전달하여 기존에 설정된 이름을 의도치 않게 삭제하는 경우
- [ ] 렌더링 루프 내부에서 동일 객체의 이름을 매 프레임 재설정하여 CPU 오버헤드를 유발하는 경우
- [ ] `objectType` 열거형 값과 실제 객체 핸들의 타입이 일치하지 않는 경우
- [ ] 이미 파괴된 객체의 이름을 갱신하는 행위 — 미정의 동작(Undefined Behavior)을 유발하므로 객체 수명을 엄격히 추적해야 한다.

### 8.4. 디버그 라벨

- [ ] `vkCmdBeginDebugUtilsLabelEXT`와 `vkCmdEndDebugUtilsLabelEXT`의 호출 횟수가 일치하지 않아 스택 불균형이 발생하는 경우 (검증 레이어가 불균형을 감지함)
- [ ] 큐 라벨은 단일 `vkQueueSubmit` 호출에만 유효하므로 제출마다 명시적으로 시작 및 종료해야 함을 간과하는 경우
- [ ] 디바이스 레벨 함수 포인터를 `vkGetInstanceProcAddr`로 조회하여 디스패치 오버헤드를 유발하는 경우 (`vkGetDeviceProcAddr` 권장)
- [ ] 프로덕션 빌드에서 확장을 비활성화했을 때 함수 포인터 유효성 검사 매크로가 누락되어 비정상 종료되는 경우

### 8.5. 성능 및 동기화

- [ ] 콜백 함수의 연산량이 많아 **메인 스레드가 지연**되는 경우 — 콜백 내부에서는 락프리(Lock-free) 큐에 로그 데이터를 적재하고 별도 로깅 스레드에서 처리하도록 구성한다.
- [ ] GPU-assisted 기능이 활성화된 상태에서 성능을 측정하여 왜곡된 프로파일링 결과를 얻는 경우 (성능 프로파일링 시 검증 레이어 비활성화 필수)
- [ ] 콜백마다 콘솔 출력을 반복하여 성능이 저하되는 경우 — 빈도를 제한(Rate Limiting)하거나 오류(`ERROR`) 등급만 즉시 출력하도록 필터링한다.
- [ ] 검증 레이어를 로드하지 못하는 경우 — Vulkan SDK 설치 상태 및 `VK_LAYER_PATH` 환경 변수 설정을 확인한다.

---

## 9. 표준 인스턴스 생성 예제 코드

```c
// 1) 사용 가능한 레이어 확인
uint32_t layerCount = 0;
vkEnumerateInstanceLayerProperties(&layerCount, nullptr);
std::vector<VkLayerProperties> layers(layerCount);
vkEnumerateInstanceLayerProperties(&layerCount, layers.data());

bool hasValidation = std::any_of(layers.begin(), layers.end(),
    [](const VkLayerProperties& l) {
        return strcmp(l.layerName, "VK_LAYER_KHRONOS_validation") == 0;
    });

// 2) 메신저 및 검증 기능 pNext 체인 구성
VkDebugUtilsMessengerCreateInfoEXT mci{};
mci.sType = VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT;
mci.messageSeverity = VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT |
                      VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT;
mci.messageType = VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT |
                  VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT |
                  VK_DEBUG_UTILS_MESSAGE_TYPE_PERFORMANCE_BIT_EXT;
mci.pfnUserCallback = debugCallback;
mci.pUserData = nullptr;

VkValidationFeaturesEXT vf{};
vf.sType = VK_STRUCTURE_TYPE_VALIDATION_FEATURES_EXT;
VkValidationFeatureEnableEXT enables[] = {
    VK_VALIDATION_FEATURE_ENABLE_BEST_PRACTICES_EXT,
    VK_VALIDATION_FEATURE_ENABLE_SYNCHRONIZATION_VALIDATION_EXT,
};
vf.enabledValidationFeatureCount = 2;
vf.pEnabledValidationFeatures = enables;

mci.pNext = &vf;  // 메신저 구조체의 pNext에 검증 기능 구조체 연결

// 3) 인스턴스 생성 정보 작성
VkApplicationInfo ai{};
ai.sType              = VK_STRUCTURE_TYPE_APPLICATION_INFO;
ai.pApplicationName   = "VulkanApp";
ai.applicationVersion = VK_MAKE_VERSION(1, 0, 0);
ai.pEngineName        = "VulkanEngine";
ai.engineVersion      = VK_MAKE_VERSION(1, 0, 0);
ai.apiVersion         = VK_API_VERSION_1_3;

VkInstanceCreateInfo ici{};
ici.sType            = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
ici.pApplicationInfo = &ai;

const char* layerNames[] = { "VK_LAYER_KHRONOS_validation" };
// VkValidationFeaturesEXT를 pNext에 체이닝하려면 VK_EXT_validation_features 확장 등록 필수
// (VUID-VkInstanceCreateInfo-pNext-10243)
const char* extensionNames[] = {
    VK_EXT_DEBUG_UTILS_EXTENSION_NAME,
    VK_EXT_VALIDATION_FEATURES_EXTENSION_NAME,
};

if (hasValidation) {
    ici.enabledLayerCount       = 1;
    ici.ppEnabledLayerNames     = layerNames;
    ici.enabledExtensionCount   = 2;  // debug_utils + validation_features
    ici.ppEnabledExtensionNames = extensionNames;
    ici.pNext                   = &mci;
}

VkInstance instance = VK_NULL_HANDLE;
vkCreateInstance(&ici, nullptr, &instance);
```

메신저 콜백 함수 구현 예시:

```c
static VKAPI_ATTR VkBool32 VKAPI_CALL debugCallback(
    VkDebugUtilsMessageSeverityFlagBitsEXT       severity,
    VkDebugUtilsMessageTypeFlagsEXT              types,
    const VkDebugUtilsMessengerCallbackDataEXT*  data,
    void*                                        user)
{
    const char* sevStr = (severity & VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT)   ? "ERROR"
                       : (severity & VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT) ? "WARN"
                       : (severity & VK_DEBUG_UTILS_MESSAGE_SEVERITY_INFO_BIT_EXT)    ? "INFO"
                       : "VERBOSE";

    const char* typeStr = (types & VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT)  ? "VALIDATION"
                        : (types & VK_DEBUG_UTILS_MESSAGE_TYPE_PERFORMANCE_BIT_EXT) ? "PERF"
                        : "GENERAL";

    fprintf(stderr, "[%s][%s] %s (VUID: %s)\n",
        sevStr,
        typeStr,
        data->pMessage,
        data->pMessageIdName ? data->pMessageIdName : "None");

    return VK_FALSE;
}
```

---

## 10. 빈번히 발생하는 VUID 카테고리

| 분류 | 대표적인 VUID 패턴 | 주된 발생 원인 |
|------|-------------------|---------------|
| 사용 플래그 누락 | `VUID-VkBufferCreateInfo-usage-...` | 버퍼나 이미지 생성 시 필수 사용처 플래그(`usage`) 누락 |
| 크기 0 전달 | `VUID-VkBufferCreateInfo-size-...` | 유효하지 않은 0바이트 버퍼 크기 지정 |
| 밉 레벨 오류 | `VUID-VkImageCreateInfo-mipLevels-...` | `mipLevels` 또는 `arrayLayers`를 0으로 설정 |
| 초기 레이아웃 위반 | `VUID-VkImageCreateInfo-initialLayout-...` | `initialLayout`을 `UNDEFINED` 또는 `PREINITIALIZED` 외의 값으로 지정 |
| 큐 패밀리 인덱스 중복 | `VUID-VkBufferCreateInfo-sharingMode-...` | 동시 공유 모드(`CONCURRENT`)에서 동일 큐 패밀리 인덱스 중복 지정 |
| 구조체 타입 오류 | `VUID-Vk*CreateInfo-sType-sType` | 구조체의 `sType` 필드 설정 누락 또는 오타 |
| 미지원 pNext 구조체 | `VUID-Vk*CreateInfo-pNext-pNext` | 인스턴스/디바이스 확장에서 지원하지 않는 구조체를 체이닝 |
| 접근 마스크 누락 | `VUID-VkBufferMemoryBarrier-srcAccessMask-...` | 파이프라인 배리어에서 필수 접근 플래그(`accessMask`) 누락 |
| 파이프라인 스테이지 불일치 | `VUID-vkCmdPipelineBarrier-srcStageMask-...` | 대상 큐에서 지원하지 않는 파이프라인 스테이지 마스크 지정 |
| 서브리소스 범위 오류 | `VUID-VkImageSubresourceRange-...` | `aspectMask`가 0이거나 유효하지 않은 포맷 비트 조합 지정 |
| 복사 메모리 영역 중첩 | `VUID-vkCmdCopyBuffer-pRegions-...` | 동일 버퍼 내 복사 시 소스와 대상 메모리 영역 중첩 |
| 버퍼 오프셋 정렬 오류 | `VUID-VkBufferImageCopy-bufferOffset-...` | 버퍼 오프셋이 포맷 블록 크기 배수로 정렬되지 않음 |
| 렌더 패스 내부 호출 금지 | `VUID-vkCmdCopy*-renderpass` | 렌더 패스 실행 구간 내부에서 복사 또는 블릿 명령 호출 |

> [!TIP]
> 검증 메시지의 `pMessageIdName`에 명시된 VUID 문자열을 Khronos 공식 명세서(`docs.vulkan.org`)에서 검색하면 해당 유효성 검사 규격을 즉시 확인할 수 있다.
