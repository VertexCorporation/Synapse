// Chat payloads recovered from deployed version 9f2e9f58 (2026-05-17).
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
  "phi-3_glm": {
    template: "phi3",
    tokens: {
      system_start: "<|system|>\n",
      system_end: "<|end|>\n",
      user_start: "<|user|>\n",
      user_end: "<|end|>\n",
      assistant_start: "<|assistant|>\n",
      assistant_end: "<|end|>\n",
      stop_generation: ["<|end|>", "<|endoftext|>"]
    }
  }
};
export function inferChatFormat(id, tags = []) {
  const searchString = `${id.toLowerCase()} ${tags.join(" ").toLowerCase()}`;
  if (searchString.includes("llama-3.2") || searchString.includes("llama-3.1") || searchString.includes("llama-3"))
    return CHAT_TEMPLATES["llama-3"];
  if (searchString.includes("gemma-2") || searchString.includes("gemma"))
    return CHAT_TEMPLATES["gemma"];
  if (searchString.includes("phi-3"))
    return CHAT_TEMPLATES["phi-3_glm"];
  return CHAT_TEMPLATES["chatml"];
}
