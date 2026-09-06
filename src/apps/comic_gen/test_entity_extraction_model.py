from unittest.mock import Mock

from .llm import ScriptProcessor


def test_parse_novel_passes_selected_model():
    processor = object.__new__(ScriptProcessor)
    processor.llm = Mock(is_configured=True)
    processor.llm.chat.return_value = '{"characters": [], "scenes": [], "props": []}'

    processor.parse_novel("title", "text", model="gpt-5.6-sol")

    assert processor.llm.chat.call_args.kwargs["model"] == "gpt-5.6-sol"
