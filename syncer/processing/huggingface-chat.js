// Chat payloads recovered from deployed version 9f2e9f58 (2026-05-17),
// extended with the Llama 2 / Mistral [INST] template and GLM / Phi-4
// routing so every supported offline family gets its correct template.
const CHAT_TEMPLATES = {
  chatml: {
    template: "chatml",
    tokens: {
      system_start: "<|im_start|>system\n",
      system_end: "<|im_end|>\n",
      user_start: "<|im_start|>user\n",
      user_end: "<|im_end|>\n",
      assistant_start: "<|im_start|>assistant\n",
      assistant_end: "<|im_end|>\n",
      stop_generation: ["<|im_end|>", "<|endoftext|>"]
    }
  },
  "llama-3": {
    template: "llama3",
    tokens: {
      system_start: "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n",
      system_end: "<|eot_id|>",
      user_start: "<|start_header_id|>user<|end_header_id|>\n\n",
      user_end: "<|eot_id|>",
      assistant_start: "<|start_header_id|>assistant<|end_header_id|>\n\n",
      assistant_end: "<|eot_id|>",
      stop_generation: ["<|eot_id|>", "<|end_of_text|>"]
    }
  },
  // Llama 2 Chat and Mistral-7B-Instruct (v0.1-v0.3) share the
  // [INST] / <<SYS>> convention; mirrors the template family already
  // published for the curated manual entry mistral-7b-instruct-v02.
  llama2: {
    template: "llama2",
    tokens: {
      system_start: "<<SYS>>",
      system_end: "<</SYS>>",
      user_start: "[INST]",
      user_end: "[/INST]",
      assistant_end: "</s>",
      stop_generation: ["</s>", "[INST]", "[/INST]"]
    }
  },
  gemma: {
    template: "gemma",
    tokens: {
      user_start: "<start_of_turn>user\n",
      user_end: "<end_of_turn>\n",
      assistant_start: "<start_of_turn>model\n",
      assistant_end: "<end_of_turn>\n",
      stop_generation: ["<end_of_turn>", "<eos>"]
    }
  },
  // Phi-3 and Phi-4 both use the <|role|> + <|end|> convention, and the
  // GLM 4.x family uses the same token shape - hence the family name.
  "phi-3_glm": {
    template: "phi-3_glm",
    tokens: {
      system_start: "<|system|>\n",
      system_end: "<|end|>\n",
      user_start: "<|user|>\n",
      user_end: "<|end|>\n",
      assistant_start: "<|assistant|>\n",
      assistant_end: "<|end|>\n",
      stop_generation: ["<|end|>", "</s>"]
    }
  }
};
export function inferChatFormat(id, tags = []) {
    const searchString = `${id.toLowerCase()} ${tags.join(" ").toLowerCase()}`;
    if (searchString.includes("llama-3.2") || searchString.includes("llama-3.1") || searchString.includes("llama-3") || searchString.includes("llama3"))
        return CHAT_TEMPLATES["llama-3"];
    if (searchString.includes("llama-2") || searchString.includes("llama2"))
        return CHAT_TEMPLATES["llama2"];
    if (searchString.includes("gemma-2") || searchString.includes("gemma"))
        return CHAT_TEMPLATES["gemma"];
    if (searchString.includes("phi-3") || searchString.includes("phi3") || searchString.includes("phi-4") || searchString.includes("phi4") || searchString.includes("glm"))
        return CHAT_TEMPLATES["phi-3_glm"];
    // Hermes and Qwen families are ChatML-trained - check BEFORE the
    // generic Mistral rule so e.g. "Hermes-2-Pro-Mistral-7B" is not
    // mis-detected as a [INST] model.
    if (searchString.includes("hermes") || searchString.includes("qwen") || searchString.includes("chatml"))
        return CHAT_TEMPLATES["chatml"];
    if (searchString.includes("mistral"))
        return CHAT_TEMPLATES["llama2"];
    return CHAT_TEMPLATES["chatml"];
}
