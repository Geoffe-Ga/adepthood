import React, { useState, useRef, useEffect } from "react";
import { View, Text, TouchableOpacity, Animated, Platform } from "react-native";
import { MoreHorizontal, Edit, CheckCircle, BarChart } from "lucide-react";

// Reuse the existing style imports
import { Goal, HabitTileProps } from "./Habits.types";
import { STAGE_COLORS, getTierColor } from "./HabitsScreen";
import styles from "./Habits.styles";

// Constants
const TOOLTIP_DISPLAY_TIME = 2000; // 2 seconds to display tooltip

export const HabitTile = ({
  habit,
  onOpenGoals,
  onLogUnit,
  onOpenStats,
  onLongPress,
}: HabitTileProps) => {
  const backgroundColor = "#f8f8f8"; // Neutral background for all habits
  const stageColor = STAGE_COLORS[habit.stage];
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const [showTooltip, setShowTooltip] = useState(false);
  const [showMarkerTooltip, setShowMarkerTooltip] = useState(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [goalAchievedMessage, setGoalAchievedMessage] = useState("");
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const isMobile = Platform.OS === "ios" || Platform.OS === "android";

  const lowGoal = habit.goals.find((g) => g.tier === "low");
  const clearGoal = habit.goals.find((g) => g.tier === "clear");
  const stretchGoal = habit.goals.find((g) => g.tier === "stretch");

  // Helper to get progress percentage for goal
  const calculateProgress = (goal: Goal | undefined) => {
    if (!goal) return 0;
    // Use habit.progress (accessible via the component's scope) instead of goal.progress
    const progress = habit.progress || 0;
    return goal.is_additive
      ? Math.min(progress / goal.target, 1)
      : Math.max(0, 1 - progress / goal.target);
  };

  const lowProgress = calculateProgress(lowGoal);
  const clearProgress = calculateProgress(clearGoal);
  const stretchProgress = calculateProgress(stretchGoal);

  // Determine if a goal is subtractive (requires abstaining)
  const isSubtractive = lowGoal && !lowGoal.is_additive;

  // Show flash message when a clear goal is achieved
  useEffect(() => {
    if (goalAchievedMessage) {
      Animated.sequence([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.delay(2000),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start(() => {
        setGoalAchievedMessage("");
      });
    }
  }, [goalAchievedMessage, fadeAnim]);

  // Animation functions
  const animateIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.97,
      friction: 5,
      tension: 100,
      useNativeDriver: true,
    }).start();
  };

  const animateOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 5,
      tension: 100,
      useNativeDriver: true,
    }).start();
  };

  // Handlers
  const handlePressIn = () => {
    if (!habit.revealed) return;
    animateIn();
  };

  const handlePressOut = () => {
    if (!habit.revealed) return;
    animateOut();
    setShowTooltip(false);
  };

  const handlePress = () => {
    if (!habit.revealed) return;
    onOpenGoals();
  };

  // Determine which progress bar(s) to show and their colors
  // Always use stage color for the progress bar
  let progressBarWidth = 0;
  let goalStatus = "";
  let hasCompletedGoal = false;

  if (isSubtractive) {
    // Subtractive goals start full and decrease
    if (stretchProgress < 1) {
      progressBarWidth = stretchProgress;
      goalStatus = "in-progress";
    } else {
      progressBarWidth = 1; // Start full
      goalStatus = "maintaining";
      hasCompletedGoal = true;
    }
  } else {
    // Additive goals
    if (clearProgress >= 1 && clearGoal && stretchGoal) {
      // Clear goal met, show progress to stretch goal
      // Calculate the ratio only if both clearGoal and stretchGoal exist
      const clearToStretchRatio = clearGoal.target / stretchGoal.target;
      progressBarWidth =
        clearToStretchRatio +
        ((stretchProgress - clearToStretchRatio) / (1 - clearToStretchRatio)) *
          (1 - clearToStretchRatio);

      if (stretchProgress >= 1) {
        goalStatus = "completed";
        hasCompletedGoal = true;
      } else {
        goalStatus = "clear-met";
        hasCompletedGoal = true;
      }
    } else if (lowProgress >= 1 && clearGoal && lowGoal) {
      // Low goal met; show progress toward clear goal if clearGoal is defined
      const lowToClearRatio = lowGoal.target / clearGoal.target;
      progressBarWidth =
        lowToClearRatio +
        ((clearProgress - lowToClearRatio) / (1 - lowToClearRatio)) *
          (1 - lowToClearRatio);
      goalStatus = "low-met";
      hasCompletedGoal = true;
    } else {
      // Working on the low goal (or fallback if clearGoal is not set)
      progressBarWidth = lowProgress;
      goalStatus = "starting";
    }
  }

  // Calculate marker positions
  // For additive goals, normalize against clearGoal
  // For subtractive goals, normalize against lowGoal (the leftmost marker)
  const getMarkerPositions = () => {
    if (!lowGoal) return { low: 0, clear: 0, stretch: 0 };

    if (lowGoal.is_additive) {
      // For additive goals, if there's a clear goal, use it as the base
      if (clearGoal) {
        const lowPosition = (lowGoal.target / clearGoal.target) * 100;
        // Clear goal is always at 100% of the progress bar
        const clearPosition = 100;
        // Stretch goal is beyond the visible bar
        const stretchPosition = stretchGoal ? 100 : 0;

        return { low: lowPosition, clear: clearPosition, stretch: stretchPosition };
      }
      // If no clear goal, just use low goal
      else {
        return { low: 100, clear: 0, stretch: 0 };
      }
    }
    // For subtractive goals
    else {
      // For subtractive goals, if there's a low goal, use it as the base
      if (lowGoal) {
        const maxTarget = lowGoal.target;
        const minTarget = stretchGoal ? stretchGoal.target : 0;

        // Normalize based on the range: lowTarget (max) to stretchTarget (min)
        const normalize = (value: number) =>
          ((value - minTarget) / (maxTarget - minTarget)) * 100;

        const lowPosition = 0; // far left
        const clearPosition = clearGoal ? normalize(clearGoal.target) : 50;
        const stretchPosition = 100; // far right

        return { low: lowPosition, clear: clearPosition, stretch: stretchPosition };
      }
      else {
        return { low: 0, clear: 0, stretch: 0 };
      }
    }
  };

  const { low: lowMarkerPosition, clear: clearMarkerPosition, stretch: stretchMarkerPosition } = getMarkerPositions();

  // Show action menu (for mobile)
  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  // Show marker tooltip on hover/press
  const showMarkerInfo = (tier) => {
    setShowMarkerTooltip(tier);

    // Auto-hide tooltip after a delay
    setTimeout(() => {
      setShowMarkerTooltip(null);
    }, TOOLTIP_DISPLAY_TIME);
  };

  // Format the marker tooltip text
  const getMarkerTooltipText = (tier) => {
    const goal = tier === "low" ? lowGoal : tier === "clear" ? clearGoal : stretchGoal;

    if (!goal) return "";

    // Create descriptive tooltip
    return `${tier.charAt(0).toUpperCase() + tier.slice(1)} Goal: ${goal.target} ${goal.target_unit} ${goal.frequency_unit}`;
  };

  return (
    <Animated.View
      style={[
        styles.tile,
        {
          backgroundColor,
          opacity: habit.revealed ? 1 : 0.5,
          transform: [{ scale: scaleAnim }],
          borderWidth: hasCompletedGoal ? 2 : 1,
          borderColor: hasCompletedGoal ? stageColor : "#ddd",
        },
      ]}
    >
      {/* Achievement Flash Message */}
      {goalAchievedMessage && (
        <Animated.View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            backgroundColor: stageColor,
            padding: 8,
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
            opacity: fadeAnim,
            zIndex: 10,
            alignItems: "center"
          }}
        >
          <Text style={{ fontWeight: "bold", color: "#333" }}>
            {goalAchievedMessage}
          </Text>
        </Animated.View>
      )}

      {/* Mobile Menu */}
      {isMobile && (
        <TouchableOpacity
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 5,
          }}
          onPress={toggleMenu}
        >
          <MoreHorizontal size={22} color="#333" />
        </TouchableOpacity>
      )}

      {/* Mobile Menu Popup */}
      {isMobile && isMenuOpen && (
        <View
          style={{
            position: "absolute",
            top: 36,
            right: 8,
            backgroundColor: "white",
            borderRadius: 8,
            padding: 8,
            zIndex: 10,
            ...styles.menuShadow,
            borderWidth: 1,
            borderColor: "#eee",
          }}
        >
          <TouchableOpacity
            style={{ flexDirection: "row", alignItems: "center", padding: 8 }}
            onPress={() => {
              onOpenStats();
              setIsMenuOpen(false);
            }}
          >
            <BarChart size={18} color="#333" style={{ marginRight: 8 }} />
            <Text>Stats</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={{ flexDirection: "row", alignItems: "center", padding: 8 }}
            onPress={() => {
              onLongPress();
              setIsMenuOpen(false);
            }}
          >
            <Edit size={18} color="#333" style={{ marginRight: 8 }} />
            <Text>Edit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={{ flexDirection: "row", alignItems: "center", padding: 8 }}
            onPress={() => {
              onLogUnit();
              setIsMenuOpen(false);
            }}
          >
            <CheckCircle size={18} color="#333" style={{ marginRight: 8 }} />
            <Text>Log</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Desktop Action Icons */}
      {!isMobile && (
        <View style={{
          position: "absolute",
          top: 8,
          right: 8,
          flexDirection: "row",
          zIndex: 5,
        }}>
          <TouchableOpacity
            style={{ padding: 6 }}
            onPress={onOpenStats}
          >
            <BarChart size={18} color="#333" />
          </TouchableOpacity>

          <TouchableOpacity
            style={{ padding: 6 }}
            onPress={onLongPress}
          >
            <Edit size={18} color="#333" />
          </TouchableOpacity>

          <TouchableOpacity
            style={{ padding: 6 }}
            onPress={onLogUnit}
          >
            <CheckCircle size={18} color="#333" />
          </TouchableOpacity>
        </View>
      )}

      {/* Main tile content */}
      <TouchableOpacity
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={{ width: "100%", alignItems: "center" }}
      >
        <Text style={styles.icon}>{habit.icon}</Text>
        <Text style={[styles.name, { color: habit.revealed ? "#333" : "#aaa" }]}>{habit.name}</Text>

        {habit.revealed && (
          <View style={styles.streakContainer}>
            <Text style={styles.streakText}>
              {habit.streak} {habit.streak === 1 ? "day" : "days"}
            </Text>
          </View>
        )}

        {/* Progress Bar */}
        {habit.revealed && lowGoal && (
          <View style={[styles.progressBarContainer, { marginTop: 12 }]}>
            <View
              style={[
                styles.progressBar,
                {
                  height: 12,
                  backgroundColor: "#eee",
                  borderRadius: 6,
                  overflow: "visible",
                }
              ]}
            >
              {/* Goal markers with improved visibility and correct positioning */}
              {lowGoal && lowMarkerPosition > 0 && (
                <TouchableOpacity
                  style={[
                    styles.goalMarker,
                    {
                      left: `${lowMarkerPosition}%`,
                      height: 16,
                      width: 4,
                      top: -2,
                      backgroundColor: getTierColor("low"),
                      borderRadius: 2,
                    }
                  ]}
                  onPress={() => showMarkerInfo("low")}
                />
              )}

              {clearGoal && clearMarkerPosition > 0 && (
                <TouchableOpacity
                  style={[
                    styles.goalMarker,
                    {
                      left: `${clearMarkerPosition}%`,
                      height: 16,
                      width: 4,
                      top: -2,
                      backgroundColor: getTierColor("clear"),
                      borderRadius: 2,
                    }
                  ]}
                  onPress={() => showMarkerInfo("clear")}
                />
              )}

              {stretchGoal && stretchMarkerPosition > 0 && (
                <TouchableOpacity
                  style={[
                    styles.goalMarker,
                    {
                      left: `${stretchMarkerPosition}%`,
                      height: 16,
                      width: 4,
                      top: -2,
                      backgroundColor: getTierColor("stretch"),
                      borderRadius: 2,
                    }
                  ]}
                  onPress={() => showMarkerInfo("stretch")}
                />
              )}

              {/* Enhanced marker tooltips */}
              {showMarkerTooltip && (
                <View style={{
                  position: "absolute",
                  top: -40,
                  left: showMarkerTooltip === "low" ? `${lowMarkerPosition}%` :
                      (showMarkerTooltip === "clear" ? `${clearMarkerPosition}%` : `${stretchMarkerPosition}%`),
                  transform: [{ translateX: -50 }],
                  backgroundColor: "rgba(0,0,0,0.8)",
                  padding: 8,
                  borderRadius: 4,
                  zIndex: 10,
                  minWidth: 120,
                  alignItems: "center",
                }}>
                  <Text style={{ color: "white", fontSize: 12 }}>
                    {getMarkerTooltipText(showMarkerTooltip)}
                  </Text>
                </View>
              )}

              {/* Progress fill with stage color */}
              <View
                style={[
                  styles.progressBarFill,
                  {
                    width: `${progressBarWidth * 100}%`,
                    backgroundColor: stageColor,
                    height: "100%",
                  }
                ]}
              />
            </View>
          </View>
        )}

        {/* Achievement indicator */}
        {hasCompletedGoal ? (
            <View
                style={{
                marginTop: 3,
                marginBottom: 10,
                borderRadius: 4,
                paddingHorizontal: 6,
                paddingVertical: 2,
                backgroundColor: stageColor,
                }}
            >
                <Text style={{
                    fontSize: 12,
                    fontWeight: 'bold',
                    color: "#ffffff",
                    textShadowColor: '#000',
                    textShadowOffset: { width: 1, height: 1 },
                    textShadowRadius: 2,
                    }}>
                Goal Achieved!
                </Text>
            </View>
            ) : (
            <View
                style={{
                paddingVertical: 15,
                }}
            >
            </View>
)}
      </TouchableOpacity>
    </Animated.View>
  );
};

export default HabitTile;
