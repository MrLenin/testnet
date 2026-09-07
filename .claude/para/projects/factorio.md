Image Tile Scanner
The tile scanner scans a single tile and returns the contents of that tile as signals. It can be used to give your base an awareness of it’s surroundings.
Inputs

    Distance Signal: The scanner will scan a random tile within the specified distance of itself. Useful for finding resources and enemy bases.
    X-Tile and Y-Tile: The scanner will scan the tile at the specified XY coordinate.
    X-Tile and Y-Tile + Distance Signal: The scanner will scan a random tile within the specified distance of the specified XY coordinate.

Outputs

    The X-Tile and Y-Tile actually scanned. (plus corresponding SubX and SubY Signals)
    Land Signal or Water Signal depending on whether there is land or water.
    Enemy Unit Signal, Enemy Turret Signal, or Enemy Spawner Signal if there is an enemy of that type at the location.
    A resource signal. If there is a minable resource it will return the mineable result (Raw Wood from Trees, etc).
    The item required to build any structures at the location (roboport, assembly machine, etc).
    Unit ID Signal (requires AAI Programmable Vehicles) if scanning a tile with a controlled unit.


Image Zone Scanner: (Requires AAI Zones)
The Zone Scanner allows you to get the position of the nth zone tile placed of a certain type. Zones placed with the Zone Planner tool and Zone Controller are part of the same list. If zone tiles are removed from the list all the other tile indexes are updated. As long as there is at least 1 zone tile then there will always be a valid zone at index 1 (and -1).
Inputs

    Any Zone Signal, e.g: Zone Box Blue 5, or Zone Circle Red -1
    The count specified in the Zone Signal determines which zone tile is scanned. 1 means the first zone tile of that type that was placed. 5 means the 5th tile that was placed. -1 means the last (most recently) placed tile. If you specify a tile out of range then no tile is returned.

Outputs

    Count-Of-Type signal. The value is the number of zone tiles of that type that currently exist. Useful for looping through tiles.
    Zone Signal of the zone type scanned. The count is the zone index scanned. This will usually be the same as the input count unless you used a negative number.
    The X-Tile and Y-Tile actually scanned. (plus corresponding SubX and SubY Signals)


Image Zone Controller: (Requires AAI Zones)
The Zone Controller allows you to place zone tiles automatically by feeding in X-Tile and Y-Tile coordinate signals and the type of zone you would like to place. It can also be used to clear zones if a position is specified with no zone to add. Some example uses:
Paint a trail under a player as the player runs around. The trail zone tiles are in order, meaning that you could cause something to follow the player’s exact path by following the tiles in order.
Put zones of different types under different types of resources. You can then scan those zones to get the locations of resources more quickly (for mining vehicles or blueprints stamping down mining drills)
Put attack zones near enemy bases.
Add and remove zones near railway crossings so the other things (vehicles) can react to the current zone situation.
Inputs

    X-Tile and Y-Tile: Clears zones from the target tile (only affects your force).
    X-Tile and Y-Tile + A Zone Signal (e.g: Zone Box Cyan or Zone Disc Yellow): Creates a Zone Tile of the specified type at the specified XY location.


Image Unit Scanner: (Requires AAI Programmable Vehicles)
Allows you to scan a specific vehicle, unit or player using it’s current ID within the list of alive units of that type. ID signals for units and vehicles are automatically generated based on active mods and can be found in the Signals tab. You can do things like check a unit’s location, speed, inventory items, health, combat status, etc. To scan a player input the Player Signal matching the player’s player_index. If you use the Player Cursor Signal, then the position returned will be the position of something that the player’s cursor is hovering over, or the player’s position if there is nothing at the cursor’s location.
Inputs

    Vehicle/Unit ID signal (in Signals Tab): The type of vehicle chosen and the count specified determines which vehicle is scanned in order of deployment. Negative values are in reverse order. E.g: Miner 1 means the 1st Miner placed. Chaingunner 5 means the 5th Chaingunner placed. Hauler -1 means the most recently placed Hauler.
    Player Signal or Player Cursor Signal: The count input defines which player is scanned based on the player’s player_index. In single-player use Player Signal 1. The Cursor version is the same but the position returned is different IF the player cursor is hovering over something selectable (there’s no way to constantly get the cursor position).

Outputs

    Count-Of-Type: The number of vehicles currently deployed of the specified type. Useful for looping. This value is returned even if there is no vehicle found at the specified index.
    Vehicle/Unit ID signal: The Type and ID actually scanned. This will usually be the same as the input count unless you used a negative number.
    Speed Signal
    Angle Signal (0 and 360 are North, 90 is East, 180 is South, 270 is West)
    X-Tile and Y-Tile of the vehicle’s position.
    Sub-X-Tile and Sub-Y-Tile of the vehicle’s position. (100 * the X and Y Tile values).
    Health Signal (the absolute health)
    Energy Signal (the internal power buffer)
    Time Since Moved Signal: Number of ticks since the vehicle changed tile. If this value is high it is probably stuck or idle.
    Time Since Target Locked: Number of ticks since the vehicle locked onto a target. If this value is low it is probably in combat.
    Time Since Last Command: Number of ticks since the vehicle was last given a command, either by the Remote Control tool or by a Unit Controller. Can be used to delay subsequent orders.
    Item signals for any items that are in the vehicles inventory, fuel inventory, or ammo inventory. Can be used to help automate Haulers to collect resources or supply fuel and ammo.
    Inventory Slot Signal for the number of empty inventory slots.
    The type of Zone under the vehicle’s tile (if any). Useful for making a waypoint system, train crossing, zone-based roads, etc.


Image Unit Controller: (Requires AAI Programmable Vehicles)
Allows you to set a command to a vehicle/unit.
Inputs

    Vehicle/Unit ID signal (in Signals Tab): The type of vehicle chosen and the count specified determines which vehicle is scanned in order of deployment. Negative values are in reverse order. E.g: Miner 1 means the 1st Miner placed. Chaingunner 5 means the 5th Chaingunner placed. Hauler -1 means the most recently placed Hauler.
    Vehicle/Unit ID + Angle Signal: The vehicle rotates to the specified Angle.
    Vehicle/Unit ID + Angle Signal + Speed: The vehicle rotates to the specified Angle and tries to match the specified speed.
    Vehicle/Unit ID + (Sub-X-Tile and/or Sub-Y-Tile): The Sub-XY tile offset is converted to an angle and speed. Sub-X-Tile 1 and Sub-Y-Tile 1 means go South East VERY slowly. Sub-X-Tile -1000 and Sub-Y-Tile 500 means go West-South-West quickly. If you can get the Sub-XY positions of two objects you can subtract them to get the Sub-XY difference between them. If you use these values as your command signal it will make the vehicle go directly towards (or away from) the target.
    Vehicle/Unit ID + (Sub-X-Tile and/or Sub-Y-Tile) + Speed: The Sub-XY offset is used to determine angle, but the Speed Signal overrides the desired speed.
    Vehicle/Unit ID + (X-Tile and/or Tile): If X or Y is unspecified then 0 is assumed. The vehicle is sent a command to get to the specified XY tile. It uses biter pathfinding to do this (same as the Remote Control tool) so it can be a bit derpy. If you set repeated commands to the same location the subsequent ones will be ignored until a different location is specified.


Image Unit Data Scanner: (Requires AAI Programmable Vehicles)
Unit Data is used for automatic inventory transfer (see Programmable Vehicles for more details). You can also use Unit Data to store information on a unit or vehicle and the Unit Data Scanner allows you to access that information.
Inputs:

    Vehicle/Unit ID signal (in Signals Tab): The type of vehicle chosen and the count specified determines which vehicle is scanned in order of deployment. Negative values are in reverse order. E.g: Miner 1 means the 1st Miner placed. Chaingunner 5 means the 5th Chaingunner placed. Hauler -1 means the most recently placed Hauler.

Outputs:

    Count-Of-Type: The number of vehicles currently deployed of the specified type. Useful for looping. This value is returned even if there is no vehicle found at the specified index.
    Vehicle/Unit ID signal: The Type and ID actually scanned. This will usually be the same as the input count unless you used a negative number.
    Any signals stored in the vehicle. Note: This is not affected by vehicle’s inventory or current state.


Image Unit Data Controller: (Requires AAI Programmable Vehicles)
Unit Data is used for automatic inventory transfer (see Programmable Vehicles for more details). The Unit Data Controller allows you to overwrite a vehicle’s Unit Data at any time. If you use this on a vehicle it completely replaces ALL of the vehicle’s existing unit data, so if you want to modify the existing values use the Unit Data Scanner to get the current data, make some changes, then feed that info into the Unit Data Controller. Also be aware that setting signals that are Item Signals will affect the automatic inventory transfer system, but virtual signals will not. If you need to store things like quads or resource zone assignments you are better off using letters, numbers, or zone signals.
Inputs:

    Vehicle/Unit ID signal (in Signals Tab): The type of vehicle chosen and the count specified determines which vehicle is scanned in order of deployment. Negative values are in reverse order. E.g: Miner 1 means the 1st Miner placed. Chaingunner 5 means the 5th Chaingunner placed. Hauler -1 means the most recently placed Hauler.
    + Any signals you want to store in the vehicle.
    Note: Vehicle/Unit ID signals and Count-Of-Type signals cannot be saved to unit data.

Image Vehicle Deployer: (Requires AAI Programmable Vehicles)
Any car-type items placed in the deployer are deployed (turned from an item into an actual vehicle) and conveyored out of the building. You can place transport belt under the output conveyor so it can be carried somewhere for fueling, ammo loading, etc. IF you connect the structure to a circuit network then any input signals are saved to the vehicle’s Unit Data (see Programmable Vehicles for more details). This means that you can deploy a Hauler that will only accept a certain type of resource (for dedicated unloading depots), or deploy vehicles with a squad identifier (e.g: “A”).