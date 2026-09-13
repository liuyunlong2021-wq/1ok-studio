"""测试全局隔离。

`ComicGenPipeline` 的数据文件用的是**相对路径**（`output/library_assets.json`、
`output/projects.json` 等，见 `pipeline.py` 的 `library_data_file`）。从仓库根运行
pytest 时 cwd 就是仓库根，于是测试会读到**开发者本机的 `<repo>/output/`**：

- 全局资产库里恰好有一个角色 → `test_series.py` / `test_cross_phase.py` 里
  「只应返回本集资产」的断言就多出一个，测试失败；
- 换台机器、或把 `<repo>/output/` 清空，同一批测试又会通过。

也就是说这些测试的结果取决于本地文件状态，而不是代码。这里给每个测试一个临时 cwd，
并在其中预先建好空的 `output/`，让它们看到干净的初始状态。
"""

import pytest


@pytest.fixture(autouse=True)
def isolate_working_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    yield
