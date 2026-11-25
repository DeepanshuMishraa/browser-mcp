# Initial Notes 

Model Used For Testing: Opus 5.5 , reasoning: medium

## What the agent sees, and why

 - A screenshot takes a lot of tokens + the agent would need to guess for elements might not be totally accurate
 - Raw HTML might be super lengthy and can have things that we might not need at all ( classes, ids etc.)
 
 My Pick: 
   - Accessiblity tree but canvas apps would have empty accessiblity tree in the beggining so a hybrid sort of approach where if there is something in the accessiblity tree go with it else take a screenshot  as a fallback . We would need to trim down elements from the tree that might not be needed like hidden nodes etc.  

   Accessiblity tree would look something like: 
     - textbox "Enter your email"
     - button "Sign In"


## Naming the Elements 

 - If we just pass the let's say the button field name, let's say like click sign in or things like it, but there might be two different or three sign-in buttons or same text there, so it will be difficult for the agent to know where to click

 - We can send a CSS selector like ID or class but in the step one itself the agent is not seeing the HTML so we will not be able to do that either

 - The best approach will be to provide some identifier to the snapshot that we are taking in the first step, whatever the agent sees, it should be having like it sees the accessibility, so it sees the text box. So provide a special ID or identifier to it and then reserve that identifier like click let's say we have given it an ID like one, so click one now every like node or element in the accessibility tree will have a unique ID so that should work

 - But for if we are only doing things on the canvas, we should be okay with coordinates as well


## How you know a page has finished reacting

So when in the second step you know when aaction would happen like click happens or something like that happens anything could happen like the page would navigate to a different URL it would refresh an animation would come or something could happen how would we know the page has finished reacting if we take a snapshot early the page might already be loading or it might not have shown the content that it we need or if we are too late the agent would be wasting its time and you know burning the time


- So we can actually watch the network tab to see if there are no no requests firing and if there are no requests it means yeah that a page has finished reacting

- Or we can just look at the DOM. So, if the DOM state is not changing, like we can observe the DOM with some way, and if the DOM state It remains thus like it changes after like say a certain amount of time and it is unchanged after that it means like re-render has happened or something has happened on the page and it means the same

## how the agent learns what an action did
 

- A diff would be a good thing which shows what changed from the original state in the accessibility tree. for eg: 

    textbox "enter your email" [2] -> textbox "Enter otp" [5]
    url "/login" -> url "/login/verify"


## Left out 

- Captachas 
- Extension popups 
- OS Dialogs like file picker etc 



# What changed 

- Initally we were running one step per call and for the potrait task it costs $1.32 out of which most of the turns were just color changes because the color picker is not accessible so added `batch` to run many steps per call this should reduce the cost

- for retina displays screenshot was 2x so we were getting coordinates wrong so scaled image to CSS pixels

- diff is matched by ref → changed / added / removed, focus moved shown as one line


- capped pages with long lists that agents might not need . so show only first 40 items for page more than 50 items and then use `find` tool to find the item we need and then snapshot it 

- settle was waiting 500ms for both network and DOM after every action which was too slow so now its 250ms DOM and 300ms network, and only requests that start after the action count. analytics/telemetry requests are ignored since they keep firing on their own

- pages that are always changing (video playing, live cursors) never go quiet so they were hitting the 5s timeout every time. now if the page was already changing before the action we just wait a fixed 300ms

- every action was taking a full snapshot before and after which is slow on big pages so now the last snapshot is reused as the "before" if the page hasnt changed (a mutation counter in the page tells us that)

- diff was printing the whole old line and whole new line for a change so now it only shows what changed like `value="a@b.c"`

- in `batch` the agent can click/type by name + role instead of ref so one call can open a menu, click an item and fill the dialog without taking a snapshot in between

- if a ref went stale because the element re-rendered we now pick the one element with same role and name instead of failing

- agent wasnt using `batch` at all in one run because claude code only shows mcp tool names until the tool is loaded. so added server instructions that tell it to use `batch` , in the cross site run 34 of 74 calls were batch

- screenshots stay in context for every turn after so batch screenshots are now half size by default and can be cropped to the canvas

- file pickers: `showOpenFilePicker`/`showSaveFilePicker` always open a native dialog we cant handle so we remove them from the page and apps fall back to normal file input and downloads. also added `drop_files` and `paste` so files can go in without any picker

- added `paste` for sheets/docs so a whole table can be pasted in one call instead of typing cell by cell

- removed bring to front, agent should never move the users tabs

- tried adding shape filling for painting (ellipse, rect) but removed it since it only helps drawing tasks and real apps have their own shape tools

- kleki: $1.31 in 242s before → $1.16 in 219s after. mcp time went 44s → 18s but model time stayed ~200s so next thing to cut is turns not mcp speed


