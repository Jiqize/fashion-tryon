-- Tryon 合集：一键打开项目页。项目服务在跑就复用，否则后台拉起；选素材目录、新建项目都在项目页里做
-- __PATH__ / __NODE__ / __CLI__ 由 scripts/install-launcher.sh 安装时替换
use AppleScript version "2.4"
use scripting additions

property cli : "export PATH='__PATH__'; '__NODE__' '__CLI__' open"

on run
	set output to do shell script cli & " --json 2>&1 || true"
	if output does not contain "\"ok\":true" then display alert "打开项目页失败" message output as warning
end run
