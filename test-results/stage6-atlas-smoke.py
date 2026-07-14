import asyncio
import json
import os
import re
from pathlib import Path

from playwright.async_api import async_playwright


ATLAS_URL = os.environ.get("ATLAS_URL", "http://127.0.0.1:8788/")
EXPECTED_ACCEPTED = int(os.environ.get("EXPECTED_ACCEPTED", "325"))
SCREENSHOT_PATH = Path(__file__).with_name("stage6-atlas-final.png")
DEEP_SCREENSHOT_PATH = Path(__file__).with_name("stage6-atlas-depth-7.png")


async def main() -> None:
    console_errors: list[str] = []
    page_errors: list[str] = []

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=True,
            executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        )
        page = await browser.new_page(viewport={"width": 1800, "height": 1100})
        await page.route(
            "**/favicon.ico",
            lambda route: route.fulfill(status=204, body=""),
        )
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        await page.goto(ATLAS_URL, wait_until="networkidle")
        atlas_data = json.loads(await page.locator("#atlas-data").text_content())
        summary = atlas_data["summary"]
        assert summary["eligibleSemanticNodes"] == 325, summary
        assert summary["acceptedSemanticNodes"] == EXPECTED_ACCEPTED, summary
        workbench_box = await page.locator(".workbench").bounding_box()
        assert workbench_box and workbench_box["height"] >= 900, workbench_box
        diagnostics = page.locator(".diagnostic-band")
        assert await diagnostics.count() == 1
        assert await diagnostics.get_attribute("open") is None

        await page.locator('[data-stage="6"]').click()
        deep_path = [
            "src/main.ts",
            "src/App.vue",
            "src/router/index.js",
            "src/router/customRouter.js",
            "src/views/standardMerchantManage/rectification/detail.vue",
            "src/components/rectification/merchantInspection/detail.vue",
            "src/components/rectification/merchantInspection/components/merchantInfoDesc.vue",
            "src/components/qualificationPreview/QualificationsPreview.vue",
        ]
        await page.locator("#file-search").fill(deep_path[0])
        for parent_path, child_path in zip(deep_path, deep_path[1:]):
            expand = page.locator(f'[data-expand="{parent_path}"]')
            if await expand.count() and await expand.get_attribute("aria-expanded") == "false":
                await expand.evaluate("element => element.click()")
            child = page.locator(f'[data-node-card="{child_path}"]')
            for _ in range(150):
                if await child.count():
                    break
                more = page.locator(f'[data-more="{parent_path}"]')
                assert await more.count(), f"Cannot reveal {child_path} under {parent_path}"
                await more.evaluate("element => element.click()")
            assert await child.count(), child_path
        caption = await page.locator("#graph-caption").text_content()
        depth_match = re.search(r"(\d+) 层", caption or "")
        assert depth_match and int(depth_match.group(1)) > 5, caption
        assert "达到 5 层上限" not in await page.locator("body").inner_text()
        camera_wheel = await page.evaluate(
            """() => {
                const viewport = document.querySelector('#flow-viewport');
                const card = document.querySelector('[data-node-card="src/main.ts"]');
                const styleBefore = getComputedStyle(card);
                const visualBefore = {
                    backgroundColor: styleBefore.backgroundColor,
                    border: styleBefore.border,
                    boxShadow: styleBefore.boxShadow,
                    fontFamily: styleBefore.fontFamily,
                    padding: styleBefore.padding,
                    width: styleBefore.width
                };
                const cameraBefore = {
                    x: Number(viewport.dataset.cameraX),
                    y: Number(viewport.dataset.cameraY),
                    scale: Number(viewport.dataset.cameraScale)
                };
                const move = new WheelEvent('wheel', {
                    deltaX: 180,
                    deltaY: 0,
                    cancelable: true
                });
                viewport.dispatchEvent(move);
                const cameraAfterMove = {
                    x: Number(viewport.dataset.cameraX),
                    y: Number(viewport.dataset.cameraY),
                    scale: Number(viewport.dataset.cameraScale)
                };
                const rect = viewport.getBoundingClientRect();
                const zoom = new WheelEvent('wheel', {
                    deltaY: -20,
                    ctrlKey: true,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2,
                    cancelable: true
                });
                viewport.dispatchEvent(zoom);
                const styleAfter = getComputedStyle(card);
                return {
                    movePrevented: move.defaultPrevented,
                    zoomPrevented: zoom.defaultPrevented,
                    before: cameraBefore,
                    afterMove: cameraAfterMove,
                    after: {
                        x: Number(viewport.dataset.cameraX),
                        y: Number(viewport.dataset.cameraY),
                        scale: Number(viewport.dataset.cameraScale)
                    },
                    visualBefore,
                    visualAfter: {
                        backgroundColor: styleAfter.backgroundColor,
                        border: styleAfter.border,
                        boxShadow: styleAfter.boxShadow,
                        fontFamily: styleAfter.fontFamily,
                        padding: styleAfter.padding,
                        width: styleAfter.width
                    }
                };
            }"""
        )
        assert camera_wheel["movePrevented"], camera_wheel
        assert camera_wheel["zoomPrevented"], camera_wheel
        assert camera_wheel["afterMove"] == camera_wheel["before"], camera_wheel
        assert camera_wheel["after"]["scale"] > camera_wheel["before"]["scale"], camera_wheel
        assert camera_wheel["visualAfter"] == camera_wheel["visualBefore"], camera_wheel

        viewport = page.locator("#flow-viewport")
        await viewport.focus()
        await page.keyboard.press("0")
        touch_gestures = await page.evaluate(
            """() => {
                const viewport = document.querySelector('#flow-viewport');
                const camera = () => ({
                    x: Number(viewport.dataset.cameraX),
                    y: Number(viewport.dataset.cameraY),
                    scale: Number(viewport.dataset.cameraScale)
                });
                const pointer = (type, id, x, y, buttons = 1) => viewport.dispatchEvent(
                    new PointerEvent(type, {
                        pointerId: id,
                        pointerType: 'touch',
                        clientX: x,
                        clientY: y,
                        button: type === 'pointerdown' ? 0 : -1,
                        buttons,
                        bubbles: true,
                        cancelable: true
                    })
                );
                const beforeSlide = camera();
                pointer('pointerdown', 101, 420, 480);
                pointer('pointerdown', 102, 520, 480);
                pointer('pointermove', 101, 440, 480);
                pointer('pointermove', 102, 540, 480);
                const afterSlide = camera();
                pointer('pointerup', 101, 440, 480, 0);
                pointer('pointerup', 102, 540, 480, 0);

                pointer('pointerdown', 201, 420, 480);
                pointer('pointerdown', 202, 520, 480);
                pointer('pointermove', 201, 390, 480);
                pointer('pointermove', 202, 550, 480);
                const afterPinch = camera();
                pointer('pointerup', 201, 390, 480, 0);
                pointer('pointerup', 202, 550, 480, 0);
                return {beforeSlide, afterSlide, afterPinch};
            }"""
        )
        assert touch_gestures["afterSlide"] == touch_gestures["beforeSlide"], touch_gestures
        assert touch_gestures["afterPinch"]["scale"] > touch_gestures["afterSlide"]["scale"], touch_gestures
        await viewport.focus()
        await page.keyboard.press("0")
        camera_before_drag = await viewport.evaluate(
            "element => ({x: Number(element.dataset.cameraX), y: Number(element.dataset.cameraY)})"
        )
        viewport_box = await viewport.bounding_box()
        assert viewport_box
        drag_start_x = viewport_box["x"] + 48
        drag_start_y = min(viewport_box["y"] + 180, 1020)
        await page.mouse.move(drag_start_x, drag_start_y)
        await page.mouse.down()
        await page.mouse.move(drag_start_x + 90, drag_start_y - 54, steps=6)
        await page.mouse.up()
        await page.wait_for_timeout(20)
        camera_after_drag = await viewport.evaluate(
            "element => ({x: Number(element.dataset.cameraX), y: Number(element.dataset.cameraY), scale: Number(element.dataset.cameraScale)})"
        )
        assert camera_after_drag["x"] > camera_before_drag["x"] + 80, (
            camera_before_drag,
            camera_after_drag,
        )
        assert camera_after_drag["y"] < camera_before_drag["y"] - 45, (
            camera_before_drag,
            camera_after_drag,
        )
        assert camera_after_drag["scale"] == 1
        await viewport.focus()
        await page.keyboard.press("0")
        centered_root = await page.evaluate(
            """() => {
                const viewport = document.querySelector('#flow-viewport').getBoundingClientRect();
                const root = document.querySelector('.flow-card--root').getBoundingClientRect();
                return {
                    viewportCenterX: viewport.left + viewport.width / 2,
                    rootCenterX: root.left + root.width / 2,
                    rootTop: root.top - viewport.top,
                    cameraX: Number(document.querySelector('#flow-viewport').dataset.cameraX)
                };
            }"""
        )
        assert abs(centered_root["viewportCenterX"] - centered_root["rootCenterX"]) < 2, centered_root
        assert centered_root["rootTop"] >= 40, centered_root
        await page.locator("#file-search").focus()
        await page.locator("#flow-viewport").screenshot(path=str(DEEP_SCREENSHOT_PATH))

        long_summary_path = "src/components/AccountOpeningApplyXiaMenSub.vue"
        await page.locator("#file-search").fill(long_summary_path)
        await page.locator(".file-path").filter(has_text=long_summary_path).wait_for()
        await page.locator(
            f'[data-semantic-summary-toggle="{long_summary_path}"]'
        ).click()
        toggle = page.locator(
            f'[data-semantic-summary-toggle="{long_summary_path}"]'
        )
        assert await toggle.get_attribute("aria-expanded") == "true"
        summary_locator = page.locator(
            f'[data-node-card="{long_summary_path}"] .flow-card__semantic'
        )
        assert "flow-card__semantic--collapsed" not in (
            await summary_locator.get_attribute("class") or ""
        )
        assert await page.locator(".semantic-nav").is_visible()
        assert await page.locator(".semantic-responsibility").is_visible()
        assert await page.locator(".semantic-evidence").first.is_visible()

        sample_paths = [
            "src/components/Look.vue",
            "src/views/standardMerchantManage/querySubMerchantChange/BindBranchChangeDetail.vue",
            "src/api/add-merchant.js",
            "src/router/customRouter.js",
            "src/store/index.js",
            "public/index.html",
        ]
        card_colors: dict[str, str] = {}
        for source_path in sample_paths:
            await page.locator("#file-search").fill(source_path)
            await page.locator(".file-path").filter(has_text=source_path).wait_for()
            assert await page.locator(".semantic-responsibility").is_visible(), source_path
            card = page.locator(f'[data-node-card="{source_path}"]')
            card_colors[source_path] = await card.evaluate(
                "element => getComputedStyle(element).backgroundColor"
            )
        assert len(set(card_colors.values())) >= 5, card_colors

        await page.locator("#file-search").fill("src/components/Look.vue")
        await page.locator(".file-path").filter(has_text="src/components/Look.vue").wait_for()
        skip_link_state = await page.locator(".skip-link").evaluate(
            """element => ({
                active: document.activeElement === element,
                focusVisible: element.matches(':focus-visible'),
                top: getComputedStyle(element).top,
                transform: getComputedStyle(element).transform
            })"""
        )
        await page.locator("#atlas").screenshot(path=str(SCREENSHOT_PATH))

        assert not console_errors, console_errors
        assert not page_errors, page_errors
        print(
            json.dumps(
                {
                    "accepted": summary["acceptedSemanticNodes"],
                    "eligible": summary["eligibleSemanticNodes"],
                    "sampleFiles": 7,
                    "expandedDepth": int(depth_match.group(1)),
                    "cameraWheel": camera_wheel,
                    "cameraDrag": {
                        "before": camera_before_drag,
                        "after": camera_after_drag,
                    },
                    "touchGestures": touch_gestures,
                    "centeredRoot": centered_root,
                    "workbenchHeight": workbench_box["height"],
                    "uniqueCardColors": len(set(card_colors.values())),
                    "cardColors": card_colors,
                    "skipLink": skip_link_state,
                    "consoleErrors": console_errors,
                    "pageErrors": page_errors,
                    "screenshot": str(SCREENSHOT_PATH),
                    "deepScreenshot": str(DEEP_SCREENSHOT_PATH),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
